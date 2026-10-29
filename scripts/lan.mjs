import { networkInterfaces } from 'node:os';

export function isPrivateIPv4(address) {
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255)
    && (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168));
}
export function findLanAddress(interfaces = networkInterfaces(), explicit = process.env.DEV_LAN_HOST) {
  const addresses = Object.entries(interfaces).flatMap(([name, entries]) => (entries || [])
    .filter(entry => entry.family === 'IPv4' && !entry.internal && isPrivateIPv4(entry.address))
    .map(entry => ({ name, address: entry.address })));
  if (explicit) {
    const selected = addresses.find(entry => entry.address === explicit);
    if (!selected) throw new Error('DEV_LAN_HOST должен быть частным IPv4 одного из локальных интерфейсов.');
    return { ...selected, addresses };
  }
  const candidates = addresses.filter(entry => !/tailscale|vpn|veth|docker|vethernet|virtual|tun|meta/i.test(entry.name));
  candidates.sort((a, b) => Number(!/wi-?fi|wlan|wireless|беспровод/i.test(a.name)) - Number(!/wi-?fi|wlan|wireless|беспровод/i.test(b.name)) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!candidates.length) throw new Error('Не найден частный LAN IPv4. Подключитесь к локальной сети или укажите DEV_LAN_HOST.');
  return { ...candidates[0], addresses };
}
