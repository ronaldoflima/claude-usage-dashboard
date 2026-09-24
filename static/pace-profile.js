/* Average matching workday hours, preserving weekend slots and weekly mass. */
function paceProfileSlots(profile, mode) {
  const weekly = profile?.weekly;
  const slots = weekly?.slots;
  if (!Array.isArray(slots) || slots.length !== 168) return null;
  if (mode !== 'equal_weekdays') return slots;
  const resetHour = weekly.reset_weekday * 24 + weekly.reset_hour;
  const hourlyMeans = Array(24).fill(0);
  slots.forEach((value, slot) => {
    const hour = (resetHour + slot) % 168;
    if (Math.floor(hour / 24) < 5) hourlyMeans[hour % 24] += value / 5;
  });
  return slots.map((value, slot) => {
    const hour = (resetHour + slot) % 168;
    return Math.floor(hour / 24) < 5 ? hourlyMeans[hour % 24] : value;
  });
}

// Rotate calendar-hour weights to the actual account window, interpolating
// fractional hours at the hourly resolution of the historical profile.
function alignedPaceSlots(profile, mode, startMs) {
  const slots = paceProfileSlots(profile, mode);
  if (!slots || !Number.isFinite(startMs)) return slots;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: profile.weekly.timezone, weekday: 'short', hour: '2-digit',
    minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(startMs)).map(part => [part.type, part.value]));
  const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday);
  const offset = (day * 24 + Number(parts.hour) + Number(parts.minute) / 60
    + Number(parts.second) / 3600 - profile.weekly.reset_weekday * 24
    - profile.weekly.reset_hour + 168) % 168;
  const whole = Math.floor(offset), fraction = offset - whole;
  return slots.map((_, index) => slots[(index + whole) % 168] * (1 - fraction)
    + slots[(index + whole + 1) % 168] * fraction);
}

if (typeof module !== 'undefined') module.exports = { paceProfileSlots, alignedPaceSlots };
