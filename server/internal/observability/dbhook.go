package observability

import (
	"context"
	"time"

	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"
)

// RecordDBQuery wraps a database call, recording its duration and success.
// Only the queryName is recorded — NEVER query parameters or result data.
func (m *Metrics) RecordDBQuery(ctx context.Context, queryName string, fn func() error) error {
	start := time.Now()
	err := fn()
	durationMS := float64(time.Since(start).Milliseconds())

	errStr := ""
	if err != nil {
		errStr = "true"
	}

	attrs := otelmetric.WithAttributes(
		attribute.String(AttrDBQueryName, queryName),
		attribute.String(AttrDBError, errStr),
	)

	m.DBQueryDuration.Record(ctx, durationMS, attrs)
	m.DBQueryTotal.Add(ctx, 1, attrs)

	return err
}

// metricAttr is a convenience for a single string attribute option.
func metricAttr(key, value string) otelmetric.MeasurementOption {
	return otelmetric.WithAttributes(attribute.String(key, value))
}
