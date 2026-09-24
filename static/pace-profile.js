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

if (typeof module !== 'undefined') module.exports = { paceProfileSlots };
