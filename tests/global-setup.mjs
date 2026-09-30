// Start every run from an empty local database and no stored rooms, via
// the yard dev control panel (loopback only).
const PANEL = "http://localhost:9875/__yard/dev/api/";

export default async function globalSetup() {
  for (const path of ["db/reset", "rooms/reset"]) {
    const res = await fetch(PANEL + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (!res.ok) throw new Error(`yard dev ${path} answered ${res.status}`);
  }
}
