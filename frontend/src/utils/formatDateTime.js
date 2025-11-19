export function formatDateTime(value) {
  if (!value) {
    return 'unspecified time';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'unspecified time';
  }
  return `${date.toLocaleDateString()} · ${date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })}`;
}
