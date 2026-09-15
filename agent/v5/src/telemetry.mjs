import { context, propagation, trace, SpanStatusCode } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';

const sdk = new NodeSDK({
  resource: resourceFromAttributes({ 'service.name': 'workshop-agent', 'service.version': 'v5' }),
  traceExporter: new OTLPTraceExporter({ timeoutMillis: 3000 }),
});
sdk.start();
const tracer = trace.getTracer('workshop-agent', 'v5');

export function traced(name, attributes, fn) {
  return tracer.startActiveSpan(name, { attributes }, async span => {
    try {
      return await fn(span);
    } catch (error) {
      // Do not export provider error bodies, prompts, responses, or credentials.
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'operation failed' });
      throw error;
    } finally {
      span.end();
    }
  });
}
export function failed(span) {
  span.setStatus({ code: SpanStatusCode.ERROR, message: 'probe failed' });
}
export function traceHeaders() {
  const headers = {};
  propagation.inject(context.active(), headers);
  return headers;
}
export function traceFields() {
  const span = trace.getSpan(context.active())?.spanContext();
  return span ? { traceId: span.traceId, spanId: span.spanId } : {};
}
export async function shutdownTracing() {
  try { await sdk.shutdown(); } catch { /* Export failures must not affect monitoring. */ }
}
