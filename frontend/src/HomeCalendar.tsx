import { useTranslation } from 'react-i18next';
import type { CalendarViewMode } from './homeReturn';

export type CalendarDay = { date: string; hasAssets: boolean; count: number; thumbnail_url?: string | null };
export type CalendarHeatmap = { year: number; month: number | null; days: CalendarDay[] };

const weekdayKeys = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const monthKeys = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december'] as const;

export function shiftCalendarMonth(year: number, month: number, step: -1 | 1): { year: number; month: number } {
  const shifted = new Date(Date.UTC(year, month - 1 + step, 1));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1 };
}

export function adjacentCalendarPeriod(year: number, month: number, mode: CalendarViewMode, step: -1 | 1) {
  return mode === 'year' ? { year: year + step, month } : shiftCalendarMonth(year, month, step);
}

export function HomeCalendar({ year, month, mode, days, weekStart, loading, onMonthOpen, onDayOpen }: {
  year: number;
  month: number;
  mode: CalendarViewMode;
  days: CalendarDay[];
  weekStart: number;
  loading: boolean;
  onMonthOpen: (month: number) => void;
  onDayOpen: (date: string) => void;
}) {
  const { t } = useTranslation();
  const daysByDate = new Map(days.map(day => [day.date, day]));

  return <div className={mode === 'year' ? 'calendar-year' : 'calendar-month'}>

    {mode === 'year' ? <div className="calendar-year-grid">
      {monthKeys.map((key, index) => <section className="calendar-mini-month" key={key} aria-label={t(`calendar.months.${key}`)}
        onClick={event => { if (!(event.target as HTMLElement).closest('button')) onMonthOpen(index + 1); }}>
        <h3><button type="button" className="calendar-mini-month-title" onClick={() => onMonthOpen(index + 1)}>
          {t(`calendar.months.${key}`)}</button></h3>
        <CalendarMonthGrid year={year} month={index + 1} daysByDate={daysByDate} weekStart={weekStart}
          loading={loading} showThumbnails={false} onDayOpen={onDayOpen} />
      </section>)}
    </div> : <CalendarMonthGrid year={year} month={month} daysByDate={daysByDate} weekStart={weekStart}
      loading={loading} showThumbnails onDayOpen={onDayOpen} />}
  </div>;
}

export function HomeCalendarNavigation({ year, month, mode, minYear, maxYear, dateLocale, onYearChange, onMonthChange, onNavigate, onModeChange, onCurrentMonth, onCurrentYear }: {
  year: number;
  month: number;
  mode: CalendarViewMode;
  minYear: number;
  maxYear: number;
  dateLocale: string;
  onYearChange: (year: number) => void;
  onMonthChange: (month: number) => void;
  onNavigate: (year: number, month: number) => void;
  onModeChange: (mode: CalendarViewMode) => void;
  onCurrentMonth: () => void;
  onCurrentYear: () => void;
}) {
  const { t } = useTranslation();
  const dateParts = new Intl.DateTimeFormat(dateLocale, { year: 'numeric', month: 'long' })
    .formatToParts(new Date(Date.UTC(year, 0, 1)));
  const yearFirst = dateParts.findIndex(part => part.type === 'year') < dateParts.findIndex(part => part.type === 'month');
  const previous = adjacentCalendarPeriod(year, month, mode, -1);
  const next = adjacentCalendarPeriod(year, month, mode, 1);
  function move(target: { year: number; month: number }) {
    onNavigate(target.year, target.month);
  }

  return <div className="calendar-navigation">
      <button type="button" className="calendar-arrow" aria-label={t(mode === 'year' ? 'calendar.previousYear' : 'calendar.previousMonth')}
        disabled={previous.year < minYear}
        onClick={() => move(previous)}>←</button>
      <button type="button" className="calendar-view-toggle" onClick={() => onModeChange(mode === 'year' ? 'month' : 'year')}>
        {t(mode === 'year' ? 'calendar.monthView' : 'calendar.yearView')}</button>
      {yearFirst ? <>
        <YearSelect year={year} minYear={minYear} maxYear={maxYear} onChange={onYearChange} />
        <MonthSelect month={month} onChange={onMonthChange} />
      </> : <>
        <MonthSelect month={month} onChange={onMonthChange} />
        <YearSelect year={year} minYear={minYear} maxYear={maxYear} onChange={onYearChange} />
      </>}
      <button type="button" className="calendar-current-month" onClick={mode === 'year' ? onCurrentYear : onCurrentMonth}>
        {t(mode === 'year' ? 'calendar.thisYear' : 'calendar.thisMonth')}</button>
      <button type="button" className="calendar-arrow" aria-label={t(mode === 'year' ? 'calendar.nextYear' : 'calendar.nextMonth')}
        disabled={next.year > maxYear}
        onClick={() => move(next)}>→</button>
    </div>;
}

function YearSelect({ year, minYear, maxYear, onChange }: {
  year: number; minYear: number; maxYear: number; onChange: (year: number) => void;
}) {
  const { t } = useTranslation();
  return <>
    <label className="visually-hidden" htmlFor="calendar-year">{t('calendar.year')}</label>
    <select id="calendar-year" aria-label={t('calendar.year')} value={year} onChange={event => onChange(Number(event.target.value))}>
      {Array.from({ length: maxYear - minYear + 1 }, (_, index) => {
        const optionYear = minYear + index;
        return <option key={optionYear} value={optionYear}>{t('calendar.yearOption', { year: optionYear })}</option>;
      })}
    </select>
  </>;
}

function MonthSelect({ month, onChange }: { month: number; onChange: (month: number) => void }) {
  const { t } = useTranslation();
  return <>
    <label className="visually-hidden" htmlFor="calendar-month">{t('calendar.month')}</label>
    <select id="calendar-month" aria-label={t('calendar.month')} value={month} onChange={event => onChange(Number(event.target.value))}>
      {monthKeys.map((key, index) => <option key={key} value={index + 1}>{t(`calendar.months.${key}`)}</option>)}
    </select>
  </>;
}

function CalendarMonthGrid({ year, month, daysByDate, weekStart, loading, showThumbnails, onDayOpen }: {
  year: number; month: number; daysByDate: Map<string, CalendarDay>; weekStart: number;
  loading: boolean; showThumbnails: boolean; onDayOpen: (date: string) => void;
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
        const thumbnail = available && showThumbnails ? entry.thumbnail_url : null;
        return <button key={date} type="button" className={`calendar-day${available ? ' has-assets' : ''}${thumbnail ? ' has-thumbnail' : ''}${date === todayKey ? ' today' : ''}`}
          disabled={!available} aria-label={available ? t('calendar.dayWithAssets', { date }) : t('calendar.dayLabel', { date })}
          onClick={() => onDayOpen(date)}>
          {thumbnail && <img className="calendar-day-thumbnail" src={thumbnail} alt="" loading="lazy" />}
          <span className="calendar-day-number">{day}</span>
      </button>;
      })}
    </div>;
}
