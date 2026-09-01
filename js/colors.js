/** Shared elevation color ramps (used by the 3D preview, color 3MF export,
 * and the 2D topo map renderer). */

// Hypsometric-ish gradient from low to high land.
export const LAND_GRADIENT = [
  [0.0, [0x2c, 0x6e, 0x49]],
  [0.3, [0x8a, 0xb1, 0x7c]],
  [0.55, [0xc9, 0xb2, 0x8f]],
  [0.75, [0x8d, 0x6e, 0x63]],
  [0.9, [0xe8, 0xe8, 0xe8]],
  [1.0, [0xff, 0xff, 0xff]],
];

// Bathymetric gradient from deepest to the waterline.
export const SEA_GRADIENT = [
  [0.0, [0x0a, 0x19, 0x44]],
  [0.55, [0x16, 0x4c, 0x8c]],
  [1.0, [0x7e, 0xc4, 0xda]],
];

export function gradientColor(stops, t) {
  for (let k = 1; k < stops.length; k++) {
    const [t1, c1] = stops[k];
    const [t0, c0] = stops[k - 1];
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0 || 1);
      return [
        (c0[0] + (c1[0] - c0[0]) * f) / 255,
        (c0[1] + (c1[1] - c0[1]) * f) / 255,
        (c0[2] + (c1[2] - c0[2]) * f) / 255,
      ];
    }
  }
  return [1, 1, 1];
}
