package api

import (
	"bufio"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// ---- Rate Limiting ----

// IPRateLimiter implements per-IP token bucket rate limiting.
type IPRateLimiter struct {
	mu       sync.Mutex
	limiters map[string]*rateLimiterEntry
	rate     rate.Limit
	burst    int
}

type rateLimiterEntry struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

func NewIPRateLimiter(r float64, burst int) *IPRateLimiter {
	rl := &IPRateLimiter{
		limiters: make(map[string]*rateLimiterEntry),
		rate:     rate.Limit(r),
		burst:    burst,
	}
	go rl.cleanup()
	return rl
}

func (rl *IPRateLimiter) getLimiter(ip string) *rate.Limiter {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	entry, exists := rl.limiters[ip]
	if !exists {
		limiter := rate.NewLimiter(rl.rate, rl.burst)
		rl.limiters[ip] = &rateLimiterEntry{limiter: limiter, lastSeen: time.Now()}
		return limiter
	}
	entry.lastSeen = time.Now()
	return entry.limiter
}

// cleanup removes stale entries every 5 minutes.
func (rl *IPRateLimiter) cleanup() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		rl.mu.Lock()
		for ip, entry := range rl.limiters {
			if time.Since(entry.lastSeen) > 10*time.Minute {
				delete(rl.limiters, ip)
			}
		}
		rl.mu.Unlock()
	}
}

// RateLimitMiddleware returns HTTP middleware that enforces per-IP rate limits.
func RateLimitMiddleware(rl *IPRateLimiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := extractIP(r)
			limiter := rl.getLimiter(ip)
			if !limiter.Allow() {
				w.Header().Set("Retry-After", "1")
				http.Error(w, `{"error":"too many requests"}`, http.StatusTooManyRequests)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func extractIP(r *http.Request) string {
	// Check X-Forwarded-For first for proxied requests.
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.SplitN(xff, ",", 2)
		return strings.TrimSpace(parts[0])
	}
	if xri := r.Header.Get("X-Real-IP"); xri != "" {
		return strings.TrimSpace(xri)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// ---- Request Logging ----

// statusRecorder captures the HTTP status code from ResponseWriter.
type statusRecorder struct {
	http.ResponseWriter
	statusCode int
}

func (sr *statusRecorder) WriteHeader(code int) {
	sr.statusCode = code
	sr.ResponseWriter.WriteHeader(code)
}

// Hijack implements http.Hijacker so WebSocket upgrades work through the logging middleware.
func (sr *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if hj, ok := sr.ResponseWriter.(http.Hijacker); ok {
		return hj.Hijack()
	}
	return nil, nil, fmt.Errorf("underlying ResponseWriter does not implement http.Hijacker")
}

// RequestLoggingMiddleware logs method, path, status, and duration for each request.
func RequestLoggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, statusCode: http.StatusOK}
		next.ServeHTTP(rec, r)
		duration := time.Since(start)
		slog.Info("request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.statusCode,
			"duration_ms", duration.Milliseconds(),
			"ip", extractIP(r),
		)
	})
}

// ---- Input Validation ----

// MaxBodySizeMiddleware limits request body size for non-upload routes.
func MaxBodySizeMiddleware(maxBytes int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Skip body size limiting for upload routes and WebSocket upgrades.
			if strings.Contains(r.URL.Path, "/upload") || r.URL.Path == "/ws" {
				next.ServeHTTP(w, r)
				return
			}
			if r.Body != nil && r.ContentLength > maxBytes {
				http.Error(w, `{"error":"request body too large"}`, http.StatusRequestEntityTooLarge)
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
			next.ServeHTTP(w, r)
		})
	}
}

// ContentTypeValidationMiddleware ensures POST/PUT/PATCH requests have a valid Content-Type.
func ContentTypeValidationMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost || r.Method == http.MethodPut || r.Method == http.MethodPatch {
			// Skip for WebSocket, upload, and OPTIONS.
			if r.URL.Path == "/ws" || strings.Contains(r.URL.Path, "/upload") {
				next.ServeHTTP(w, r)
				return
			}
			ct := r.Header.Get("Content-Type")
			if ct != "" && !strings.HasPrefix(ct, "application/json") && !strings.HasPrefix(ct, "multipart/form-data") {
				http.Error(w, fmt.Sprintf(`{"error":"unsupported content type: %s"}`, ct), http.StatusUnsupportedMediaType)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
