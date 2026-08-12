/**
 * platform/resilience — the composition of §3.3, §4 and §5 into one object
 * that every external port is wrapped in.
 */
export { createPortGuard, withTimeout } from './port-guard';
export type { GuardedCallOptions, PortGuard, PortGuardOptions } from './port-guard';
export { createResilienceRegistry, GUARDED_PORTS } from './registry';
export type {
  GuardedPortName,
  ResilienceRegistry,
  ResilienceRegistryOptions,
} from './registry';
