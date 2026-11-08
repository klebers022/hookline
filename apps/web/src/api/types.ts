// The API's responses, written by hand: the routes declare no response
// schemas, so the OpenAPI document has no output types to generate them
// from (ADR 11). The Playwright test runs against the real API.

export type DeliveryStatus = 'pending' | 'retrying' | 'succeeded' | 'dead';
export type EndpointStatus = 'active' | 'disabled';

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

export interface Event {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface EventDelivery {
  id: string;
  endpoint_id: string;
  endpoint_url: string;
  status: DeliveryStatus;
  attempt_count: number;
  next_attempt_at: string | null;
  delivered_at: string | null;
  created_at: string;
}

export interface EventDetail extends Event {
  deliveries: EventDelivery[];
}

export interface PublishedEvent {
  id: string;
  deliveries: number;
}

export interface Delivery extends EventDelivery {
  event_id: string;
  event_type: string;
}

export interface Attempt {
  attempt_number: number;
  started_at: string;
  duration_ms: number | null;
  response_status: number | null;
  error_code: string | null;
  response_snippet: string | null;
}

export interface DeliveryDetail extends Delivery {
  attempts: Attempt[];
}

export interface Endpoint {
  id: string;
  url: string;
  event_types: string[];
  status: EndpointStatus;
  consecutive_failures: number;
  circuit_open_until: string | null;
  created_at: string;
  updated_at: string;
}

// The secret is only in the responses that create it.
export interface EndpointWithSecret extends Endpoint {
  secret: string;
}

export function isFinal(status: DeliveryStatus): boolean {
  return status === 'succeeded' || status === 'dead';
}
