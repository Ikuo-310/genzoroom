import { useTranslation } from 'react-i18next';
import type { CalendarViewMode } from './homeReturn';

export type CalendarDay = { date: string; hasAssets: boolean; count: number };
export type CalendarHeatmap = { year: number; month: number | null; days: CalendarDay[] };

const weekdayKeys = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const monthKeys = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december'] as const;

export function shiftCalendarMonth(year: number, month: number, step: -1 | 1): { year: number; month: number } {
  const shifted = new Date(Date.UTC(year, month - 1 + step, 1));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1 };
}

export function HomeCalendar({ year, month, mode, minYear, maxYear, days, weekStart, loading, onYearChange, onMonthChange, onNavigate, onModeChange, onCurrentMonth, onCurrentYear, onDayOpen }: {
  year: number;
  month: number;
  mode: CalendarViewMode;
  minYear: number;
  maxYear: number;
  days: CalendarDay[];
  weekStart: number;
  loading: boolean;
  onYearChange: (year: number) => void;
  onMonthChange: (month: number) => void;
  onNavigate: (year: number, month: number) => void;
  onModeChange: (mode: CalendarViewMode) => void;
  onCurrentMonth: () => void;
  onCurrentYear: () => void;
  onDayOpen: (date: string) => void;
}) {
  const { t } = useTranslation();
  const daysByDate = new Map(days.map(day => [day.date, day]));
  const previous = mode === 'year' ? { year: year - 1, month } : shiftCalendarMonth(year, month, -1);
  const next = mode === 'year' ? { year: year + 1, month } : shiftCalendarMonth(year, month, 1);
  function move(target: { year: number; month: number }) {
    onNavigate(target.year, target.month);
  }

  return <div className={mode === 'year' ? 'calendar-year' : 'calendar-month'}>
    <div className="calendar-navigation">
      <button type="button" className="calendar-arrow" aria-label={t(mode === 'year' ? 'calendar.previousYear' : 'calendar.previousMonth')}
        disabled={previous.year < minYear}
        onClick={() => move(previous)}>←</button>
      <button type="button" className="calendar-view-toggle" onClick={() => onModeChange(mode === 'year' ? 'month' : 'year')}>
        {t(mode === 'year' ? 'calendar.monthView' : 'calendar.yearView')}</button>
      <label className="visually-hidden" htmlFor="calendar-year">{t('calendar.year')}</label>
      <select id="calendar-year" aria-label={t('calendar.year')} value={year}
        onChange={event => onYearChange(Number(event.target.value))}>
        {Array.from({ length: maxYear - minYear + 1 }, (_, index) => {
          const optionYear = minYear + index;
          return <option key={optionYear} value={optionYear}>{t('calendar.yearOption', { year: optionYear })}</option>;
        })}
      </select>
      <label className="visually-hidden" htmlFor="calendar-month">{t('calendar.month')}</label>
      <select id="calendar-month" aria-label={t('calendar.month')} value={month}
        onChange={event => onMonthChange(Number(event.target.value))}>
        {monthKeys.map((key, index) => <option key={key} value={index + 1}>{t(`calendar.months.${key}`)}</option>)}
      </select>
      <button type="button" className="calendar-current-month" onClick={mode === 'year' ? onCurrentYear : onCurrentMonth}>
        {t(mode === 'year' ? 'calendar.thisYear' : 'calendar.thisMonth')}</button>
      <button type="button" className="calendar-arrow" aria-label={t(mode === 'year' ? 'calendar.nextYear' : 'calendar.nextMonth')}
        disabled={next.year > maxYear}
        onClick={() => move(next)}>→</button>
    </div>
    {mode === 'year' ? <div className="calendar-year-grid">
      {monthKeys.map((key, index) => <section className="calendar-mini-month" key={key} aria-label={t(`calendar.months.${key}`)}>
        <h3>{t(`calendar.months.${key}`)}</h3>
        <CalendarMonthGrid year={year} month={index + 1} daysByDate={daysByDate} weekStart={weekStart}
          loading={loading} showCounts={false} onDayOpen={onDayOpen} />
      </section>)}
    </div> : <CalendarMonthGrid year={year} month={month} daysByDate={daysByDate} weekStart={weekStart}
      loading={loading} showCounts onDayOpen={onDayOpen} />}
  </div>;
}

function CalendarMonthGrid({ year, month, daysByDate, weekStart, loading, showCounts, onDayOpen }: {
  year: number; month: number; daysByDate: Map<string, CalendarDay>; weekStart: number;
  loading: boolean; showCounts: boolean; onDayOpen: (date: string) => void;
}) {
  const { t } = useTranslation();
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const offset = (firstWeekday - weekStart + 7) % 7;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return <div className="calendar-days" role="group" aria-label={t('calendar.gridLabel', { year, month })}>
      {weekdayKeys.map((_, index) => <span className="calendar-weekday" aria-hidden="true" key={index}>
        {t(`calendar.weekdays.${weekdayKeys[(weekStart + index) % 7]}`)}
      </span>)}
      {Array.from({ length: offset }, (_, index) => <span className="calendar-blank" aria-hidden="true" key={`blank-${index}`} />)}
      {Array.from({ length: daysInMonth }, (_, index) => {
        const day = index + 1;
        const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const entry = daysByDate.get(date);
        const available = !loading && entry?.hasAssets === true;
        return <button key={date} type="button" className={`calendar-day${available ? ' has-assets' : ''}${date === todayKey ? ' today' : ''}`}
          disabled={!available} aria-label={available ? t('calendar.dayWithAssets', { date, count: entry.count }) : t('calendar.dayLabel', { date })}
          onClick={() => onDayOpen(date)}><span className="calendar-day-number">{day}</span>
          {available && showCounts && <span className="calendar-day-count">{t('calendar.assetCount', { count: entry.count })}</span>}
        </button>;
      })}
    </div>;
}
