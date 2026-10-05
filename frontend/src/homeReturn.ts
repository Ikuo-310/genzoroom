import type { AlbumSummary } from './albums';
import { isAlbumSummary } from './api';

export type HomeTab = 'recent' | 'albums' | 'calendar' | 'favorites';
export type CalendarViewMode = 'month' | 'year';
// Route state carries only browsing context; asset data and persistent settings keep their existing owners.
export type HomeReturnContext = {
  tab: HomeTab;
  album: AlbumSummary | null;
  year: number;
  month: number;
  date: string | null;
  calendarMode?: CalendarViewMode;
  pageScrollTop: number;
  contentScrollTop: number;
};

export function readHomeReturn(value: unknown): HomeReturnContext | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as Record<string, unknown>;
  if (!['recent', 'albums', 'calendar', 'favorites'].includes(state.tab as string)) return null;
  const now = new Date();
  const validMonth = Number.isInteger(state.year) && Number(state.year) >= 1
    && Number(state.year) <= now.getFullYear() && Number.isInteger(state.month)
    && Number(state.month) >= 1 && Number(state.month) <= 12;
  const year = validMonth ? Number(state.year) : now.getFullYear();
  const month = validMonth ? Number(state.month) : now.getMonth() + 1;
  const date = validMonth && typeof state.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(state.date)
    && state.date.startsWith(`${year}-${String(month).padStart(2, '0')}-`)
    && Number(state.date.slice(8)) >= 1
    && Number(state.date.slice(8)) <= new Date(Date.UTC(year, month, 0)).getUTCDate()
    ? state.date : null;
  const offset = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  return { tab: state.tab as HomeTab, album: isAlbumSummary(state.album) && state.album.id.trim() ? state.album : null,
    year, month, date, calendarMode: state.calendarMode === 'year' ? 'year' : 'month',
    pageScrollTop: offset(state.pageScrollTop), contentScrollTop: offset(state.contentScrollTop) };
}

export function homeScrollContent(page: HTMLElement): HTMLElement | null {
  return page.querySelector('.home-content');
}

export type HomeScrollPosition = Pick<HomeReturnContext, 'pageScrollTop' | 'contentScrollTop'>;

export function homeViewKey(tab: HomeTab, albumId: string | null, year: number, month: number, date: string | null, calendarMode: CalendarViewMode = 'month') {
  if (tab === 'recent') return 'recent';
  if (tab === 'favorites') return 'favorites';
  if (tab === 'albums') return albumId ? `albums:${albumId}` : 'albums:list';
  return `calendar:${date ?? (calendarMode === 'year' ? `year:${year}` : `${year}-${String(month).padStart(2, '0')}`)}`;
}

export function restoreHomeScroll(page: HTMLElement, context: HomeScrollPosition) {
  // Keep accepting legacy page offsets in route state; the fixed shell only scrolls its content.
  page.scrollTop = 0;
  const content = homeScrollContent(page);
  if (content) content.scrollTop = context.contentScrollTop;
}
