import type { Vec, Quat } from "../simulation/types";
export const add = (a: Vec, b: Vec): Vec => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z,
});
export const sub = (a: Vec, b: Vec): Vec => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
});
export const mul = (q: Quat, r: Quat): Quat => ({
  x: q.w * r.x + q.x * r.w + q.y * r.z - q.z * r.y,
  y: q.w * r.y - q.x * r.z + q.y * r.w + q.z * r.x,
  z: q.w * r.z + q.x * r.y - q.y * r.x + q.z * r.w,
  w: q.w * r.w - q.x * r.x - q.y * r.y - q.z * r.z,
});
export const inverse = (q: Quat): Quat => ({
  x: -q.x,
  y: -q.y,
  z: -q.z,
  w: q.w,
});
export const rotate = (q: Quat, v: Vec): Vec => {
  const r = mul(mul(q, { ...v, w: 0 }), inverse(q));
  return { x: r.x, y: r.y, z: r.z };
};
export const axisRotation = (axis: Vec, a: number): Quat => ({
  x: axis.x * Math.sin(a / 2),
  y: axis.y * Math.sin(a / 2),
  z: axis.z * Math.sin(a / 2),
  w: Math.cos(a / 2),
});
export const dot = (a: Vec, b: Vec) => a.x * b.x + a.y * b.y + a.z * b.z;
export const signedAngle = (parent: Quat, child: Quat, axis: Vec) => {
  const r = mul(inverse(parent), child);
  const a = 2 * Math.atan2(r.x * axis.x + r.y * axis.y + r.z * axis.z, r.w);
  return Math.atan2(Math.sin(a), Math.cos(a));
};
