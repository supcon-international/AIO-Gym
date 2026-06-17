// Alarms (advisory) + interlocks (protective, with hysteresis) — JS, scenario-
// aware. Geometry and protective actions come from the active model's safety()
// spec: a reactor over-temperature trips the FEED (stops the reaction); level
// scenarios trip the heater (dry-fire / over-temp) and the pump (overflow).

export const LIMITS = {
  h_high_frac: 0.90, h_low_frac: 0.15, h_overflow_frac: 0.97, h_dryfire_frac: 0.10,
  h_reset_margin: 0.04, t_high: 80, t_trip: 92, t_reset_margin: 3,
};
const DEFAULT_SAFETY = { dryFire: true, overflow: true, overTempAction: 'heater' };

export class AlarmMonitor {
  constructor(model) { this.bind(model); }
  bind(model) {
    this.model = model; this.n = model.n;
    this.safety = { ...DEFAULT_SAFETY, ...(model.safety ? model.safety() : {}) };
    this.reset();
  }
  reset() { this.heaterTrip = new Array(this.n).fill(false); this.pumpTrip = false; this.feedTrip = false; }

  evaluate(s) {
    const L = LIMITS, hmax = this.model.heightMax, sf = this.safety, alarms = [];
    const add = (tank, type, sev, msg, value) => alarms.push({ tank, type, severity: sev, message: msg, value: +value.toFixed(3) });

    for (let i = 0; i < this.n; i++) {
      const hasLevel = i < s.levels.length, T = s.temps[i];
      let dryTrip = false, dryClear = true;
      if (hasLevel) {
        const h = s.levels[i];
        const hHi = L.h_high_frac * hmax[i], hLo = L.h_low_frac * hmax[i], hDf = L.h_dryfire_frac * hmax[i];
        if (h >= hHi) add(i, 'level_high', h >= L.h_overflow_frac * hmax[i] ? 'critical' : 'warning', `Tank ${i + 1} level HIGH (${h.toFixed(2)} m)`, h);
        else if (h <= hLo) add(i, 'level_low', h <= hDf ? 'critical' : 'warning', `Tank ${i + 1} level LOW (${h.toFixed(2)} m)`, h);
        dryTrip = sf.dryFire && h <= hDf;
        dryClear = h >= hDf + L.h_reset_margin * hmax[i];
      }
      if (T >= L.t_high) add(i, 'temp_high', T >= L.t_trip ? 'critical' : 'warning', `Unit ${i + 1} temperature HIGH (${T.toFixed(1)} C)`, T);
      const otHeater = sf.overTempAction === 'heater' && T >= L.t_trip;
      const tClear = T <= L.t_trip - L.t_reset_margin;
      // heater interlock (hysteretic): tripped by dry-fire or (heater-mode) over-temp
      if (dryTrip || otHeater) this.heaterTrip[i] = true;
      else if (dryClear && tClear) this.heaterTrip[i] = false;
      if (this.heaterTrip[i]) add(i, 'heater_interlock', 'critical', `Unit ${i + 1} heater TRIPPED (${dryTrip ? 'dry-fire' : 'over-temp'})`, dryTrip ? s.levels[i] : T);
    }

    // overflow -> pump trip (level scenarios)
    if (sf.overflow) {
      if (s.levels.some((h, i) => h >= L.h_overflow_frac * hmax[i])) this.pumpTrip = true;
      else if (s.levels.every((h, i) => h <= (L.h_overflow_frac - L.h_reset_margin) * hmax[i])) this.pumpTrip = false;
      if (this.pumpTrip) add(-1, 'pump_interlock', 'critical', 'Pump TRIPPED (overflow protection)', 0);
    }

    // over-temp -> feed (pump) trip, e.g. reactor runaway protection (hysteretic)
    if (sf.overTempAction === 'pump') {
      const hot = s.temps.some((T) => T >= L.t_trip);
      const cool = s.temps.every((T) => T <= L.t_trip - L.t_reset_margin);
      if (hot) this.feedTrip = true; else if (cool) this.feedTrip = false;
      if (this.feedTrip) { this.pumpTrip = true; add(-1, 'overtemp_interlock', 'critical', '进料 TRIPPED (over-temp / runaway protection)', 0); }
      else this.pumpTrip = false;
    }

    return [alarms, { heater_trip: this.heaterTrip.slice(), pump_trip: this.pumpTrip }];
  }
}
