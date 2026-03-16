package observability

import (
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/metric"
)

// Metrics holds pre-created metric instruments for the server.
// When OTel is disabled (noop provider), all operations are zero-cost.
type Metrics struct {
	// HTTP
	HTTPRequestDuration metric.Float64Histogram
	HTTPRequestsTotal   metric.Int64Counter
	HTTPActiveRequests  metric.Int64UpDownCounter

	// WebSocket
	WSActiveConnections metric.Int64UpDownCounter
	WSMessagesTotal     metric.Int64Counter

	// Database
	DBQueryDuration metric.Float64Histogram
	DBQueryTotal    metric.Int64Counter

	// Federation
	FedPeersConnected metric.Int64UpDownCounter
	FedSyncTotal      metric.Int64Counter

	// Voice
	VoiceRoomsActive    metric.Int64UpDownCounter
	VoiceParticipants   metric.Int64UpDownCounter
}

// NewMetrics creates all metric instruments from the global meter provider.
func NewMetrics() *Metrics {
	meter := otel.Meter("dilla-server")
	m := &Metrics{}

	m.HTTPRequestDuration, _ = meter.Float64Histogram("http.server.request.duration",
		metric.WithDescription("HTTP request duration in milliseconds"),
		metric.WithUnit("ms"),
	)
	m.HTTPRequestsTotal, _ = meter.Int64Counter("http.server.requests.total",
		metric.WithDescription("Total HTTP requests"),
	)
	m.HTTPActiveRequests, _ = meter.Int64UpDownCounter("http.server.active_requests",
		metric.WithDescription("Number of active HTTP requests"),
	)

	m.WSActiveConnections, _ = meter.Int64UpDownCounter("ws.connections.active",
		metric.WithDescription("Number of active WebSocket connections"),
	)
	m.WSMessagesTotal, _ = meter.Int64Counter("ws.messages.total",
		metric.WithDescription("Total WebSocket messages"),
	)

	m.DBQueryDuration, _ = meter.Float64Histogram("db.query.duration",
		metric.WithDescription("Database query duration in milliseconds"),
		metric.WithUnit("ms"),
	)
	m.DBQueryTotal, _ = meter.Int64Counter("db.query.total",
		metric.WithDescription("Total database queries"),
	)

	m.FedPeersConnected, _ = meter.Int64UpDownCounter("federation.peers.connected",
		metric.WithDescription("Number of connected federation peers"),
	)
	m.FedSyncTotal, _ = meter.Int64Counter("federation.sync.total",
		metric.WithDescription("Total federation sync operations"),
	)

	m.VoiceRoomsActive, _ = meter.Int64UpDownCounter("voice.rooms.active",
		metric.WithDescription("Number of active voice rooms"),
	)
	m.VoiceParticipants, _ = meter.Int64UpDownCounter("voice.participants",
		metric.WithDescription("Number of voice participants"),
	)

	return m
}
