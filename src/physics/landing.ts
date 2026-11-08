// Measurement only: a validated lift/forward-transfer must be followed by
// 0.2 seconds of loaded contact and stable body support. No forces are applied.
export class LandingAssessment {
  settledSteps = [0, 0, 0, 0];
  recoverySteps = 0;
  private seen = [0, 0, 0, 0];
  private pending = [false, false, false, false];
  private settled = [0, 0, 0, 0];
  private threat = [0, 0, 0, 0];
  private landingTilt = [0, 0, 0, 0];
  private sinceRecovery = Infinity;
  private recoveryX = -Infinity;
  observe(s: {
    dt: number;
    steps: number[];
    contacts: boolean[];
    stable: boolean;
    eligible: boolean;
    tilt: number;
    tiltSpeed: number;
    x: number;
  }) {
    this.sinceRecovery += s.dt;
    for (let leg = 0; leg < 4; leg++) {
      if (!s.contacts[leg] && s.eligible && s.tiltSpeed > 0.1 && s.tilt > 0.2)
        this.threat[leg] = Math.max(this.threat[leg], s.tilt);
      if (s.steps[leg] > this.seen[leg]) {
        this.pending[leg] = true;
        this.settled[leg] = 0;
        this.landingTilt[leg] = this.threat[leg];
      }
      this.seen[leg] = s.steps[leg];
      if (this.pending[leg]) {
        if (!s.contacts[leg] || !s.stable) {
          this.pending[leg] = false;
          this.settled[leg] = 0;
        } else {
          this.settled[leg] += s.dt;
          if (this.settled[leg] + 1e-9 >= 0.2) {
            this.settledSteps[leg]++;
            // Observed recovery after a step, not a claim of causality.
            // Two awards per episode, cooldown and new forward ground prevent
            // repeatedly wobbling in place from farming recovery points.
            if (
              this.landingTilt[leg] > 0.2 &&
              s.tilt < this.landingTilt[leg] * 0.65 &&
              Math.abs(s.tiltSpeed) < 0.25 &&
              this.sinceRecovery >= 2 &&
              s.x > this.recoveryX + 0.018 &&
              this.recoverySteps < 2
            ) {
              this.recoverySteps++;
              this.sinceRecovery = 0;
              this.recoveryX = s.x;
            }
            this.pending[leg] = false;
            this.threat[leg] = 0;
          }
        }
      }
      if (s.contacts[leg] || !s.eligible) this.threat[leg] = 0;
    }
  }
}
