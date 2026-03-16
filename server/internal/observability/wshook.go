package observability

import "context"

// WSConnected increments the active WebSocket connection counter.
func (m *Metrics) WSConnected() {
	m.WSActiveConnections.Add(context.Background(), 1)
}

// WSDisconnected decrements the active WebSocket connection counter.
func (m *Metrics) WSDisconnected() {
	m.WSActiveConnections.Add(context.Background(), -1)
}

// WSMessageReceived increments the WS message counter by event type.
func (m *Metrics) WSMessageReceived(eventType string) {
	m.WSMessagesTotal.Add(context.Background(), 1,
		metricAttr(AttrWSEventType, eventType),
	)
}
