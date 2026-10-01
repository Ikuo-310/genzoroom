import { useTranslation } from 'react-i18next';

export type CalendarDay = { date: string; hasAssets: boolean; count: number };
export type CalendarHeatmap = { year: number; month: number; days: CalendarDay[] };

const weekdayKeys = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const monthKeys = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december'] as const;

export function shiftCalendarMonth(year: number, month: number, step: -1 | 1): { year: number; month: number } {
  const shifted = new Date(Date.UTC(year, month - 1 + step, 1));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1 };
}

export function HomeCalendar({ year, month, minYear, maxYear, days, weekStart, loading, onYearChange, onMonthChange, onDayOpen }: {
  year: number;
  month: number;
  minYear: number;
  maxYear: number;
  days: CalendarDay[];
  weekStart: number;
  loading: boolean;
  onYearChange: (year: number) => void;
  onMonthChange: (month: number) => void;
  onDayOpen: (date: string) => void;
}) {
  const { t } = useTranslation();
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const offset = (firstWeekday - weekStart + 7) % 7;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const daysByDate = new Map(days.map(day => [day.date, day]));
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const previous = shiftCalendarMonth(year, month, -1);
  const next = shiftCalendarMonth(year, month, 1);

  return <div className="calendar-month">
    <div className="calendar-navigation">
      <button type="button" className="calendar-arrow" aria-label={t('calendar.previousMonth')}
        disabled={previous.year < minYear}
        onClick={() => { onYearChange(previous.year); onMonthChange(previous.month); }}>←</button>
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
      <button type="button" className="calendar-arrow" aria-label={t('calendar.nextMonth')}
        disabled={next.year > maxYear}
        onClick={() => { onYearChange(next.year); onMonthChange(next.month); }}>→</button>
    </div>
    <div className="calendar-days" role="group" aria-label={t('calendar.gridLabel', { year, month })}>
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
          {available && <span className="calendar-day-count">{t('calendar.assetCount', { count: entry.count })}</span>}
        </button>;
      })}
    </div>
  </div>;
}
