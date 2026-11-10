const ID_DOMAIN = '@operators.blues.invalid';
export function loginEmail(value: string): string {
 const id = value.trim().toLowerCase();
 return id.includes('@') ? id : id + ID_DOMAIN;
}
export function displayAccountId(value: string): string {
 return value.endsWith(ID_DOMAIN) ? value.slice(0, -ID_DOMAIN.length) : value;
}
