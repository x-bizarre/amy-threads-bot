import { handleAt } from '@/lib/brand-config';

export default function Home() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 40, maxWidth: 720 }}>
      <h1>Threads Bot</h1>
      <p>Автопостинг в Threads {handleAt()} и уведомления о комментариях в Telegram.</p>
      <p>
        Cron:
        <br />
        — 5 публикаций в день (ET: 07:30 / 12:15 / 17:00 / 19:30 / 21:30)
        <br />
        — проверка реплаев каждые 10 минут
      </p>
      <p>
        Ручной запуск: <code>/api/cron/autopost</code>, <code>/api/cron/replies-watcher</code>.
        Нужен заголовок <code>Authorization: Bearer $CRON_SECRET</code>.
      </p>
    </main>
  );
}
