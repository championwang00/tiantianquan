const SHANGHAI_TIME_ZONE = "Asia/Shanghai";

export function formatDateInShanghai(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SHANGHAI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

export function nowStampForId() {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: SHANGHAI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(new Date());

  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}${map.month}${map.day}_${map.hour}${map.minute}${map.second}`;
}

export function getJournalDate(capturedAt) {
  const date = new Date(capturedAt || Date.now());
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHANGHAI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  const shanghaiDate = new Date(`${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}+08:00`);
  if (Number(map.hour) < 3) {
    shanghaiDate.setDate(shanghaiDate.getDate() - 1);
  }

  return formatDateInShanghai(shanghaiDate);
}

export function formatShanghaiTime(capturedAt) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: SHANGHAI_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(capturedAt || Date.now()));
}
