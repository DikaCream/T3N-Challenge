/**
 * The operator session status, as `/api/session` returns it.
 *
 * Its own module because `app/lib/types.ts` re-exports server types and this
 * shape is purely a route payload, and keeping it separate makes it obvious which
 * types cross the boundary and which are mirrored from the enclave.
 */

export interface SessionStatus {
  did: string;
  environment: string;
  nodeUrl: string;
  credits: {
    /** Human-readable, already formatted from base units. */
    available: string;
    availableBaseUnits: number;
    reservedBaseUnits: number;
    creditExhausted: boolean;
  } | null;
  contract: {
    tail: string;
    registered: boolean;
    name: string | null;
    version: string | null;
    status: string | null;
  };
  targets: {
    identity: string;
    payroll: string;
    identityToken: boolean;
    payrollToken: boolean;
  };
}
