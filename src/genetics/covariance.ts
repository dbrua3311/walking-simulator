// Independent implementation of positive-weight covariance/path adaptation.
// Reference mathematics: https://arxiv.org/abs/1604.00772 . No robotics knowledge.
export type Vector = number[];
export type Matrix = number[][];
export const norm = (x: Vector) => Math.hypot(...x);
const eye = (n: number): Matrix =>
  Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
export function symmetricEigen(input: Matrix) {
  const n = input.length,
    A = input.map((r) => [...r]),
    Q = eye(n);
  for (let sweep = 0; sweep < 50; sweep++) {
    let largest = 0;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        const off = A[p][q];
        largest = Math.max(largest, Math.abs(off));
        if (
          Math.abs(off) <
          1e-14 * Math.sqrt(Math.max(1e-30, Math.abs(A[p][p] * A[q][q])))
        )
          continue;
        const tau = (A[q][q] - A[p][p]) / (2 * off);
        const t =
            (tau >= 0 ? 1 : -1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau)),
          c = 1 / Math.sqrt(1 + t * t),
          s = t * c;
        const app = A[p][p],
          aqq = A[q][q];
        A[p][p] = app - t * off;
        A[q][q] = aqq + t * off;
        A[p][q] = A[q][p] = 0;
        for (let r = 0; r < n; r++) {
          if (r !== p && r !== q) {
            const u = A[r][p],
              v = A[r][q];
            A[r][p] = A[p][r] = c * u - s * v;
            A[r][q] = A[q][r] = s * u + c * v;
          }
          const u = Q[r][p],
            v = Q[r][q];
          Q[r][p] = c * u - s * v;
          Q[r][q] = s * u + c * v;
        }
      }
    if (largest < 1e-13 * Math.max(...A.map((r, i) => Math.abs(r[i])), 1e-30))
      break;
  }
  const values = A.map((r, i) => r[i]);
  if (values.some((x) => !Number.isFinite(x) || x <= 0))
    throw new Error("Covariance is not positive definite");
  return { Q, values };
}
export type CovarianceState = {
  mean: Vector;
  sigma: number;
  C: Matrix;
  ps: Vector;
  pc: Vector;
  generation: number;
  mu: number;
  Q: Matrix;
  D: Vector;
};
export class CovarianceSearch {
  mean: Vector;
  sigma: number;
  C: Matrix;
  ps: Vector;
  pc: Vector;
  generation = 0;
  Q: Matrix;
  D: Vector;
  readonly n: number;
  readonly weights: Vector;
  readonly muEff: number;
  readonly cc: number;
  readonly cs: number;
  readonly c1: number;
  readonly cmu: number;
  readonly damping: number;
  readonly expectedNorm: number;
  constructor(
    mean: Vector,
    sigma: number,
    readonly mu: number,
    C?: Matrix,
  ) {
    if (
      mean.length < 1 ||
      mean.length > 64 ||
      !Number.isInteger(mu) ||
      mu < 1 ||
      mu > 60
    )
      throw new Error("Invalid covariance dimensions");
    this.mean = [...mean];
    this.n = mean.length;
    this.sigma = sigma;
    this.C = C?.map((r) => [...r]) ?? eye(this.n);
    this.ps = mean.map(() => 0);
    this.pc = mean.map(() => 0);
    const w = Array.from(
        { length: mu },
        (_, i) => Math.log(mu + 0.5) - Math.log(i + 1),
      ),
      sum = w.reduce((a, b) => a + b, 0);
    this.weights = w.map((x) => x / sum);
    this.muEff = 1 / this.weights.reduce((a, b) => a + b * b, 0);
    const n = this.n,
      m = this.muEff;
    this.cc = (4 + m / n) / (n + 4 + (2 * m) / n);
    this.cs = (m + 2) / (n + m + 5);
    this.c1 = 2 / ((n + 1.3) ** 2 + m);
    this.cmu = Math.min(
      1 - this.c1,
      (2 * (m - 2 + 1 / m)) / ((n + 2) ** 2 + m),
    );
    this.damping =
      1 + 2 * Math.max(0, Math.sqrt((m - 1) / (n + 1)) - 1) + this.cs;
    this.expectedNorm = Math.sqrt(n) * (1 - 1 / (4 * n) + 1 / (21 * n * n));
    const eig = symmetricEigen(this.C);
    this.Q = eig.Q;
    this.D = eig.values.map(Math.sqrt);
    this.validate();
  }
  validate() {
    const n = this.n;
    if (
      !(this.sigma > 0) ||
      !Number.isFinite(this.sigma) ||
      this.mean.some((x) => !Number.isFinite(x)) ||
      [this.C, this.Q].some(
        (M) =>
          M.length !== n ||
          M.some((r) => r.length !== n || r.some((x) => !Number.isFinite(x))),
      ) ||
      [this.ps, this.pc, this.D].some(
        (v) => v.length !== n || v.some((x) => !Number.isFinite(x)),
      ) ||
      this.D.some((x) => x <= 0) ||
      !Number.isInteger(this.generation) ||
      this.generation < 0
    )
      throw new Error("Invalid covariance state");
  }
  validateDecomposition() {
    const scale = Math.max(1e-30, ...this.C.flat().map(Math.abs)),
      n = this.n;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        if (Math.abs(this.C[i][j] - this.C[j][i]) > 1e-9 * scale)
          throw new Error("Covariance symmetry error");
        const dot = this.Q.reduce((s, row) => s + row[i] * row[j], 0);
        const reconstructed = this.Q[i].reduce(
          (s, q, k) => s + q * this.D[k] ** 2 * this.Q[j][k],
          0,
        );
        if (
          Math.abs(dot - (i === j ? 1 : 0)) > 1e-7 ||
          Math.abs(reconstructed - this.C[i][j]) > 1e-7 * scale
        )
          throw new Error("Covariance decomposition error");
      }
  }
  sample(rng: { normal(): number }): Vector {
    const z = Array.from({ length: this.n }, () => rng.normal());
    return this.mean.map(
      (m, i) =>
        m +
        this.sigma *
          this.Q[i].reduce((sum, q, j) => sum + q * this.D[j] * z[j], 0),
    );
  }
  update(ordered: Vector[]) {
    if (
      ordered.length < this.mu ||
      ordered
        .slice(0, this.mu)
        .some((x) => x.length !== this.n || x.some((v) => !Number.isFinite(v)))
    )
      throw new Error("Missing covariance parents");
    const old = [...this.mean],
      y = ordered
        .slice(0, this.mu)
        .map((x) => x.map((v, i) => (v - old[i]) / this.sigma));
    const yw = old.map((_, i) =>
      y.reduce((sum, v, j) => sum + this.weights[j] * v[i], 0),
    );
    this.mean = old.map((v, i) => v + this.sigma * yw[i]);
    const eigCoord = old.map(
      (_, j) =>
        this.Q.reduce((sum, row, i) => sum + row[j] * yw[i], 0) / this.D[j],
    );
    const white = old.map((_, i) =>
      this.Q[i].reduce((sum, q, j) => sum + q * eigCoord[j], 0),
    );
    this.ps = this.ps.map(
      (v, i) =>
        (1 - this.cs) * v +
        Math.sqrt(this.cs * (2 - this.cs) * this.muEff) * white[i],
    );
    const pathNorm = norm(this.ps);
    this.generation++;
    const h =
      pathNorm /
        Math.sqrt(1 - (1 - this.cs) ** (2 * this.generation)) /
        this.expectedNorm <
      1.4 + 2 / (this.n + 1)
        ? 1
        : 0;
    this.pc = this.pc.map(
      (v, i) =>
        (1 - this.cc) * v +
        h * Math.sqrt(this.cc * (2 - this.cc) * this.muEff) * yw[i],
    );
    const retain =
      1 - this.c1 - this.cmu + this.c1 * (1 - h) * this.cc * (2 - this.cc);
    this.C = this.C.map((row, i) =>
      row.map(
        (v, j) =>
          retain * v +
          this.c1 * this.pc[i] * this.pc[j] +
          this.cmu *
            y.reduce((sum, z, k) => sum + this.weights[k] * z[i] * z[j], 0),
      ),
    );
    this.sigma = Math.max(
      1e-8,
      Math.min(
        100,
        this.sigma *
          Math.exp(
            (this.cs / this.damping) * (pathNorm / this.expectedNorm - 1),
          ),
      ),
    );
    const eig = symmetricEigen(this.C);
    this.Q = eig.Q;
    const floor = Math.max(...eig.values) * 1e-12;
    this.D = eig.values.map((v) => Math.sqrt(Math.max(v, floor)));
    if (eig.values.some((v) => v < floor))
      this.C = this.Q.map((r, i) =>
        r.map((_, j) =>
          r.reduce((sum, q, k) => sum + q * this.D[k] ** 2 * this.Q[j][k], 0),
        ),
      );
    this.validate();
  }
  resetPaths() {
    this.ps.fill(0);
    this.pc.fill(0);
    this.generation = 0;
  }
  state(): CovarianceState {
    return structuredClone({
      mean: this.mean,
      sigma: this.sigma,
      C: this.C,
      ps: this.ps,
      pc: this.pc,
      generation: this.generation,
      mu: this.mu,
      Q: this.Q,
      D: this.D,
    });
  }
  static restore(s: CovarianceState) {
    const o = new CovarianceSearch(s.mean, s.sigma, s.mu, s.C);
    o.ps = [...s.ps];
    o.pc = [...s.pc];
    o.generation = s.generation;
    o.Q = s.Q.map((r) => [...r]);
    o.D = [...s.D];
    o.validate();
    o.validateDecomposition();
    return o;
  }
}
