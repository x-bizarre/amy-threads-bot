// Состояние «фото только что загружено, ждём решение пользователя».
// Хранится в Redis под ключом photo-pending:<id>.
import { get, set, del } from './redis';

export interface PhotoPending {
  id: string;
  public_path: string; // /media/.../photo.jpg
  repo_path: string; // public/media/.../photo.jpg
  telegram_message_id?: number;
  created_at: string;
}

const KEY = (id: string) => `photo-pending:${id}`;

export async function getPhotoPending(id: string): Promise<PhotoPending | null> {
  return await get<PhotoPending>(KEY(id));
}

export async function savePhotoPending(p: PhotoPending): Promise<void> {
  await set(KEY(p.id), p);
}

export async function deletePhotoPending(id: string): Promise<void> {
  await del(KEY(id));
}

export function genPhotoPendingId(): string {
  return `pp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}
