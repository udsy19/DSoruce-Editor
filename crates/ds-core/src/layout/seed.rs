//! Per-run seeded state: the tiny deterministic PRNG, the discrete structural
//! choices it draws once per `generate()`, and the global desk lattice every
//! region packs onto.

use super::*;

/// The GLOBAL desk lattice for one `generate()` call: origin snapped to the
/// module at the plate bbox min corner (plus the odd-seed half-pitch phase),
/// shared by every region so adjacent wings' rows/columns land on the same
/// lines across their seam. No continuous jitter — seed variety comes from
/// the DISCRETE `SeedChoices` below (spec §4.1: jitter put every coordinate
/// off-module, which is why plans read "broken").
#[derive(Clone, Copy)]
pub(crate) struct Lattice {
    pub(crate) ox: f64,
    pub(crate) oy: f64,
}

/// Discrete structural choices drawn once per `generate()` from the seed rng.
/// Together with the odd-seed half-pitch lattice phase and the seed-rotated
/// meeting round-robin (`allocate_regions`), these give the candidate gallery
/// structurally distinct — yet individually disciplined — layouts.
#[derive(Clone, Copy)]
pub(crate) struct SeedChoices {
    /// Meeting band anchors at the region's FAR end: a landscape wing's
    /// column moves from the right edge to the left; a portrait wing's band
    /// from the bottom edge to the top.
    pub(crate) band_far: bool,
    /// Desks per cluster before an aisle: the program's value or a valid
    /// neighbour (±1, never below 2) — shifts the cross-aisle rhythm.
    pub(crate) cluster_cols: u32,
}

impl SeedChoices {
    pub(crate) fn draw(rng: &mut Rng, program: &Program) -> SeedChoices {
        let base = program.cluster_cols.max(1);
        let cluster_cols = match rng.next_u64() % 3 {
            0 if base > 2 => base - 1,
            2 => base + 1,
            _ => base,
        };
        SeedChoices { band_far: rng.next_u64() & 1 == 1, cluster_cols }
    }
}

/// Tiny inline PRNG — xorshift64* (Marsaglia). Deterministic, no `rand` crate.
/// Used only to draw the discrete `SeedChoices` per `generate()`, so different
/// seeds yield structurally distinct but still-valid candidates.
pub(crate) struct Rng {
    pub(crate) state: u64,
}

impl Rng {
    pub(crate) fn new(seed: u64) -> Rng {
        // splitmix-style scramble; force nonzero so xorshift never sticks at 0.
        let s = (seed ^ 0x9E37_79B9_7F4A_7C15) | 1;
        Rng { state: s }
    }

    pub(crate) fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.state = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
}
