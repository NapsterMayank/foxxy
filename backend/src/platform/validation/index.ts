/**
 * platform/validation — turning a schema failure into a typed `AppError`.
 *
 * The SHAPES stay in `shared/contracts/`, where the frontend imports the
 * inferred types. This is only the boundary that applies them.
 */
export { parseInput } from './parse-input';
