import RAPIER from "@dimforge/rapier3d-compat";
let ready: Promise<void> | undefined;
export const initPhysics = () => (ready ??= RAPIER.init());
export { RAPIER };
export const ENGINE_VERSION = "rapier3d-0.21.0";
