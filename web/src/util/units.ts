// Unit conversions — pure arithmetic, no core dependency.
//
// `SF_PER_M2` was declared three times (ProgramStep, SpaceStep, and report.ts as
// `SQF_PER_M2`). All three agreed, which is exactly how this kind of duplication
// survives: nothing is wrong until one of them is edited. A conversion factor has
// one definition.

/** Square feet per square metre. */
export const SF_PER_M2 = 10.7639

/** m² → ft², for the sf figures the qbiq-style deliverables quote. */
export const m2ToSf = (m2: number): number => m2 * SF_PER_M2
