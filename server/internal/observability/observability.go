package observability

import (
	"context"
	"fmt"
	"log/slog"
	"os"

	"go.opentelemetry.io/contrib/bridges/otelslog"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploggrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	"go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	"go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// Config holds OpenTelemetry configuration.
type Config struct {
	Enabled        bool
	Protocol       string // "http" (default) or "grpc"
	Endpoint       string // primary endpoint (e.g. "api.honeycomb.io")
	HTTPEndpoint   string // dedicated HTTP endpoint; falls back to Endpoint
	Insecure       bool   // use plaintext instead of TLS
	ServiceName    string
	ServiceVersion string
	APIKey         string // auth header value (e.g. Honeycomb API key)
	APIHeader      string // auth header name (e.g. "x-honeycomb-team", "Authorization")
	LogFormat      string // "json" or "text" — for the local stdout handler
	LogLevel       slog.Level
}

// Providers holds the OTel trace, metric, and log providers.
type Providers struct {
	Trace  *trace.TracerProvider
	Metric *metric.MeterProvider
	Log    *sdklog.LoggerProvider
}

// Init sets up OpenTelemetry providers (traces, metrics, logs).
// When disabled, returns empty Providers (OTel global defaults are noop — zero overhead).
func Init(ctx context.Context, cfg Config) (*Providers, error) {
	if !cfg.Enabled {
		slog.Info("observability disabled")
		return &Providers{}, nil
	}

	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName(cfg.ServiceName),
			semconv.ServiceVersion(cfg.ServiceVersion),
		),
	)
	if err != nil {
		return nil, err
	}

	headers := map[string]string{}
	if cfg.APIKey != "" && cfg.APIHeader != "" {
		headers[cfg.APIHeader] = cfg.APIKey
	}

	protocol := cfg.Protocol
	if protocol == "" {
		protocol = "http"
	}

	var traceExporter trace.SpanExporter
	var metricExporter metric.Exporter
	var logExporter sdklog.Exporter

	switch protocol {
	case "grpc":
		traceExporter, metricExporter, logExporter, err = initGRPC(ctx, cfg.Endpoint, cfg.Insecure, headers)
	case "http":
		endpoint := cfg.HTTPEndpoint
		if endpoint == "" {
			endpoint = cfg.Endpoint
		}
		traceExporter, metricExporter, logExporter, err = initHTTP(ctx, endpoint, cfg.Insecure, headers)
	default:
		return nil, fmt.Errorf("unsupported OTEL protocol: %s (use \"grpc\" or \"http\")", protocol)
	}
	if err != nil {
		return nil, err
	}

	tp := trace.NewTracerProvider(
		trace.WithBatcher(traceExporter),
		trace.WithResource(res),
	)
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	mp := metric.NewMeterProvider(
		metric.WithReader(metric.NewPeriodicReader(metricExporter)),
		metric.WithResource(res),
	)
	otel.SetMeterProvider(mp)

	lp := sdklog.NewLoggerProvider(
		sdklog.WithProcessor(sdklog.NewBatchProcessor(logExporter)),
		sdklog.WithResource(res),
	)

	scheme := "https"
	if cfg.Insecure {
		scheme = "http"
	}
	slog.Info("observability enabled",
		"protocol", protocol,
		"endpoint", scheme+"://"+cfg.Endpoint,
		"service", cfg.ServiceName,
	)
	return &Providers{Trace: tp, Metric: mp, Log: lp}, nil
}

// NewSlogHandler returns a slog.Handler that writes to both stdout and OTel.
// When providers.Log is nil (OTel disabled), returns a plain stdout handler.
func NewSlogHandler(p *Providers, cfg Config) slog.Handler {
	handlerOpts := &slog.HandlerOptions{Level: cfg.LogLevel}

	var localHandler slog.Handler
	if cfg.LogFormat == "json" {
		localHandler = slog.NewJSONHandler(os.Stdout, handlerOpts)
	} else {
		localHandler = slog.NewTextHandler(os.Stdout, handlerOpts)
	}

	if p.Log == nil {
		return localHandler
	}

	// otelslog bridge sends logs to the OTel log provider.
	otelHandler := otelslog.NewHandler("dilla-server", otelslog.WithLoggerProvider(p.Log))

	// Fan out to both handlers.
	return &fanoutHandler{handlers: []slog.Handler{localHandler, otelHandler}}
}

// fanoutHandler sends log records to multiple slog handlers.
type fanoutHandler struct {
	handlers []slog.Handler
}

func (f *fanoutHandler) Enabled(ctx context.Context, level slog.Level) bool {
	for _, h := range f.handlers {
		if h.Enabled(ctx, level) {
			return true
		}
	}
	return false
}

func (f *fanoutHandler) Handle(ctx context.Context, r slog.Record) error {
	for _, h := range f.handlers {
		if h.Enabled(ctx, r.Level) {
			_ = h.Handle(ctx, r)
		}
	}
	return nil
}

func (f *fanoutHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	handlers := make([]slog.Handler, len(f.handlers))
	for i, h := range f.handlers {
		handlers[i] = h.WithAttrs(attrs)
	}
	return &fanoutHandler{handlers: handlers}
}

func (f *fanoutHandler) WithGroup(name string) slog.Handler {
	handlers := make([]slog.Handler, len(f.handlers))
	for i, h := range f.handlers {
		handlers[i] = h.WithGroup(name)
	}
	return &fanoutHandler{handlers: handlers}
}

func initGRPC(ctx context.Context, endpoint string, plaintext bool, headers map[string]string) (trace.SpanExporter, metric.Exporter, sdklog.Exporter, error) {
	var dialOpts []grpc.DialOption
	if plaintext {
		dialOpts = append(dialOpts, grpc.WithTransportCredentials(insecure.NewCredentials()))
	}

	traceOpts := []otlptracegrpc.Option{
		otlptracegrpc.WithEndpoint(endpoint),
		otlptracegrpc.WithDialOption(dialOpts...),
	}
	metricOpts := []otlpmetricgrpc.Option{
		otlpmetricgrpc.WithEndpoint(endpoint),
		otlpmetricgrpc.WithDialOption(dialOpts...),
	}
	logOpts := []otlploggrpc.Option{
		otlploggrpc.WithEndpoint(endpoint),
		otlploggrpc.WithDialOption(dialOpts...),
	}

	if len(headers) > 0 {
		traceOpts = append(traceOpts, otlptracegrpc.WithHeaders(headers))
		metricOpts = append(metricOpts, otlpmetricgrpc.WithHeaders(headers))
		logOpts = append(logOpts, otlploggrpc.WithHeaders(headers))
	}

	te, err := otlptracegrpc.New(ctx, traceOpts...)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("grpc trace exporter: %w", err)
	}
	me, err := otlpmetricgrpc.New(ctx, metricOpts...)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("grpc metric exporter: %w", err)
	}
	le, err := otlploggrpc.New(ctx, logOpts...)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("grpc log exporter: %w", err)
	}
	return te, me, le, nil
}

func initHTTP(ctx context.Context, endpoint string, plaintext bool, headers map[string]string) (trace.SpanExporter, metric.Exporter, sdklog.Exporter, error) {
	traceOpts := []otlptracehttp.Option{
		otlptracehttp.WithEndpoint(endpoint),
	}
	metricOpts := []otlpmetrichttp.Option{
		otlpmetrichttp.WithEndpoint(endpoint),
	}
	logOpts := []otlploghttp.Option{
		otlploghttp.WithEndpoint(endpoint),
	}

	if plaintext {
		traceOpts = append(traceOpts, otlptracehttp.WithInsecure())
		metricOpts = append(metricOpts, otlpmetrichttp.WithInsecure())
		logOpts = append(logOpts, otlploghttp.WithInsecure())
	}

	if len(headers) > 0 {
		traceOpts = append(traceOpts, otlptracehttp.WithHeaders(headers))
		metricOpts = append(metricOpts, otlpmetrichttp.WithHeaders(headers))
		logOpts = append(logOpts, otlploghttp.WithHeaders(headers))
	}

	te, err := otlptracehttp.New(ctx, traceOpts...)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("http trace exporter: %w", err)
	}
	me, err := otlpmetrichttp.New(ctx, metricOpts...)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("http metric exporter: %w", err)
	}
	le, err := otlploghttp.New(ctx, logOpts...)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("http log exporter: %w", err)
	}
	return te, me, le, nil
}

// Shutdown flushes and shuts down OTel providers.
func (p *Providers) Shutdown(ctx context.Context) {
	if p.Log != nil {
		if err := p.Log.Shutdown(ctx); err != nil {
			slog.Error("otel log shutdown error", "error", err)
		}
	}
	if p.Trace != nil {
		if err := p.Trace.Shutdown(ctx); err != nil {
			slog.Error("otel trace shutdown error", "error", err)
		}
	}
	if p.Metric != nil {
		if err := p.Metric.Shutdown(ctx); err != nil {
			slog.Error("otel metric shutdown error", "error", err)
		}
	}
}
