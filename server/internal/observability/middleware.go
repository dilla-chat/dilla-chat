package observability

import (
	"bufio"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"
)

// statusRecorder captures the HTTP status code.
type statusRecorder struct {
	http.ResponseWriter
	statusCode int
}

func (sr *statusRecorder) WriteHeader(code int) {
	sr.statusCode = code
	sr.ResponseWriter.WriteHeader(code)
}

func (sr *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if hj, ok := sr.ResponseWriter.(http.Hijacker); ok {
		return hj.Hijack()
	}
	return nil, nil, fmt.Errorf("underlying ResponseWriter does not implement http.Hijacker")
}

// HTTPMiddleware returns HTTP middleware that adds tracing, metrics, and
// structured logging with privacy-safe attributes.
func HTTPMiddleware(metrics *Metrics) func(http.Handler) http.Handler {
	tracer := otel.Tracer("dilla-server")

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()

			// Extract incoming trace context from headers.
			ctx := otel.GetTextMapPropagator().Extract(r.Context(), propagation.HeaderCarrier(r.Header))

			route := SanitizeRoute(r.URL.Path)
			ctx, span := tracer.Start(ctx, fmt.Sprintf("%s %s", r.Method, route),
				trace.WithAttributes(
					semconv.HTTPRequestMethodKey.String(r.Method),
					attribute.String(AttrHTTPRoute, route),
				),
			)
			defer span.End()

			r = r.WithContext(ctx)

			metrics.HTTPActiveRequests.Add(ctx, 1)
			defer metrics.HTTPActiveRequests.Add(ctx, -1)

			rec := &statusRecorder{ResponseWriter: w, statusCode: http.StatusOK}
			next.ServeHTTP(rec, r)

			duration := time.Since(start)
			durationMS := float64(duration.Milliseconds())

			metricAttrs := otelmetric.WithAttributes(
				attribute.String(AttrHTTPMethod, r.Method),
				attribute.String(AttrHTTPRoute, route),
				attribute.Int(AttrHTTPStatusCode, rec.statusCode),
			)

			span.SetAttributes(
				semconv.HTTPResponseStatusCode(rec.statusCode),
				attribute.Float64(AttrHTTPDurationMS, durationMS),
			)

			metrics.HTTPRequestDuration.Record(ctx, durationMS, metricAttrs)
			metrics.HTTPRequestsTotal.Add(ctx, 1, metricAttrs)

			// Structured log with hashed IP.
			slog.Info("request",
				"method", r.Method,
				"path", r.URL.Path,
				"status", rec.statusCode,
				"duration_ms", duration.Milliseconds(),
				"ip_hash", HashIP(extractIP(r)),
				"trace_id", span.SpanContext().TraceID().String(),
			)
		})
	}
}

// extractIP extracts the client IP from RemoteAddr.
func extractIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
