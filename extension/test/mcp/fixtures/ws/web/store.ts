export interface User { id: number }
export type Id = string;
export enum Color { Red }
export const MAX = 5;
export const add = (a: number, b: number): number => a + b;
export async function fetchUser(id: Id): Promise<User> {
  return { id: 1 };
}
export class Store {
  private items: User[] = [];
  async load(id: Id): Promise<void> {
    if (id) {
      fetchUser(id);
    }
  }
}
