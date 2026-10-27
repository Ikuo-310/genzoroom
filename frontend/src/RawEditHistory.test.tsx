import { renderToStaticMarkup } from 'react-dom/server';
import i18n from 'i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import './i18n';
import { RawEditHistory } from './RawEditHistory';
import type { RawHistoryStep } from './rawApi';

function rawHistory(steps: RawHistoryStep[], cursor: number) {
  return { historySteps: steps, history: { initialized: true, cursor, length: steps.length,
    selectedStepId: cursor ? steps[cursor - 1].stepId : null }, jumpHistory: vi.fn() };
}

describe('RAW History display', () => {
  beforeEach(async () => { await i18n.changeLanguage('ja'); });

  it.each(['ja', 'en'])('distinguishes luminance/color NR Detail and all five NR reset names in %s', async language => {
    await i18n.changeLanguage(language);
    const controls = ['detail.nrLuminance', 'detail.nrDetail', 'detail.nrColor', 'detail.nrColorDetail', 'detail.nrColorSmoothness'] as const;
    const steps: RawHistoryStep[] = controls.flatMap((control, index) => [
      { stepId: `${index}-edit`, kind: 'control', metadata: { control }, createdAt: '2026-10-27T00:00:00Z', changes: [{ control, before: 50, after: 73 }] },
      { stepId: `${index}-reset`, kind: 'controlReset', metadata: { control }, createdAt: '2026-10-27T00:00:00Z', changes: [{ control, before: 73, after: 0 }] },
    ]);
    const markup = renderToStaticMarkup(<RawEditHistory raw={rawHistory(steps, steps.length) as never} disabled={false} onReset={() => {}} />);
    expect(markup).toContain(language === 'ja' ? '輝度ノイズ軽減のディテール' : 'Luminance Noise Reduction Detail');
    expect(markup).toContain(language === 'ja' ? 'カラーノイズ軽減のディテール' : 'Color Noise Reduction Detail');
    expect(markup).toContain(language === 'ja' ? 'カラーノイズ軽減の滑らかさをリセット' : 'Reset color noise reduction smoothness');
    expect(markup).not.toContain('workspace.');
    expect(markup).toContain('50 → 73');
  });

  it.each(['ja', 'en'])('labels Detail controls, Reset and category operations in %s', async language => {
    await i18n.changeLanguage(language);
    const operations: Pick<RawHistoryStep, 'kind' | 'metadata' | 'changes'>[] = [
      { kind: 'control', metadata: { control: 'detail.sharpenAmount' }, changes: [{ control: 'detail.sharpenAmount', before: 40, after: 120 }] },
      { kind: 'controlReset', metadata: { control: 'detail.sharpenMasking' }, changes: [{ control: 'detail.sharpenMasking', before: 60, after: 0 }] },
      { kind: 'sectionToggle', metadata: { section: 'detail', enabled: false }, changes: [] },
      { kind: 'sectionReset', metadata: { section: 'detail' }, changes: [] },
    ];
    const steps = operations.map((step, index) => ({ ...step, stepId: String(index), createdAt: '2026-10-27T00:00:00Z' }));
    const markup = renderToStaticMarkup(<RawEditHistory raw={rawHistory(steps, steps.length) as never} disabled={false} onReset={() => {}} />);
    expect(markup).toContain(language === 'ja' ? 'シャープ量' : 'Sharpening Amount');
    expect(markup).toContain(language === 'ja' ? 'マスクをリセット' : 'Reset masking');
    expect(markup).toContain(language === 'ja' ? 'ディテール OFF' : 'Detail OFF');
    expect(markup).toContain(language === 'ja' ? 'ディテール リセット' : 'Detail Reset');
    expect(markup).toContain('40 → 120'); expect(markup).toContain('60 → 0');
  });

  it.each([['wbAuto', true], ['wbAuto', false], ['wbPick', true], ['wbPick', false]] as const)('labels %s as one operation (%s)', (kind, numeric) => {
    const step: RawHistoryStep = { stepId: '00000000-0000-4000-8000-000000000001', kind, metadata: {},
      createdAt: '2026-10-27T00:00:00Z', changes: numeric ? [
        { control: 'wb.temp', before: 6500, after: 5200 }, { control: 'wb.tint', before: 0, after: 11 }] : [] };
    const markup = renderToStaticMarkup(<RawEditHistory raw={rawHistory([step], 1) as never} disabled={false} onReset={() => {}} />);
    expect(markup).toContain(kind === 'wbAuto' ? '自動ホワイトバランス' : 'WBスポイト');
    if (numeric) { expect(markup).toContain('6500 K → 5200 K'); expect(markup).toContain('0 → +11'); }
  });

  it('shows JPEG-style before and after values, Kelvin units and no operation timestamps', () => {
    const steps: RawHistoryStep[] = [
      { stepId: '00000000-0000-4000-8000-000000000001', kind: 'control', metadata: { control: 'light.exposure' },
        createdAt: '2026-10-23T11:14:53Z', changes: [{ control: 'light.exposure', before: .7, after: .6 }] },
      { stepId: '00000000-0000-4000-8000-000000000002', kind: 'control', metadata: { control: 'wb.temp' },
        createdAt: '2026-10-23T11:14:52Z', changes: [{ control: 'wb.temp', before: 6250, after: 7100 }] },
      { stepId: '00000000-0000-4000-8000-000000000003', kind: 'control', metadata: { control: 'wb.tint' },
        createdAt: '2026-10-23T11:14:51Z', changes: [{ control: 'wb.tint', before: 0, after: -10 }] },
    ];
    const raw = rawHistory(steps, 2);
    const markup = renderToStaticMarkup(<RawEditHistory raw={raw as never} disabled={false} onReset={() => {}} />);

    expect(markup).toContain('露光量 +0.70 → +0.60');
    expect(markup).toContain('色温度 6250 K → 7100 K');
    expect(markup).toContain('色かぶり補正 0 → -10');
    expect(markup).not.toContain('2026/10/23');
    expect(markup).not.toContain('<time');
    expect(markup).toContain('<li value="2" class="current">');
    expect(markup).toContain('<li value="3" class="undone">');
    expect(markup).toContain('RAW編集をリセット');
    expect(raw.jumpHistory).not.toHaveBeenCalled();
  });

  it('keeps operation labels when the Backend cannot provide trustworthy values', () => {
    const step: RawHistoryStep = { stepId: '00000000-0000-4000-8000-000000000001', kind: 'control',
      metadata: { control: 'light.exposure' }, createdAt: '2026-10-23T11:14:53Z', changes: null };
    const markup = renderToStaticMarkup(<RawEditHistory raw={rawHistory([step], 0) as never} disabled={false} onReset={() => {}} />);
    expect(markup).toContain('露光量</button>');
    expect(markup).not.toContain('→');
    expect(markup).not.toContain('<time');
  });

  it('can present multiple control deltas for a future category or all-reset operation', () => {
    const steps: RawHistoryStep[] = [
      { stepId: '00000000-0000-4000-8000-000000000001', kind: 'sectionReset', metadata: { section: 'color' },
        createdAt: '2026-10-23T11:14:53Z', changes: [
          { control: 'wb.tint', before: 8, after: 0 }, { control: 'color.vibrance', before: 20, after: 0 }] },
      { stepId: '00000000-0000-4000-8000-000000000002', kind: 'allReset', metadata: {},
        createdAt: '2026-10-23T11:14:52Z', changes: [{ control: 'light.exposure', before: .3, after: 0 }] },
    ];
    const markup = renderToStaticMarkup(<RawEditHistory raw={rawHistory(steps, 2) as never} disabled={false} onReset={() => {}} />);
    expect(markup).toContain('カラー リセット: 色かぶり補正 +8 → 0、自然な彩度 +20 → 0');
    expect(markup).toContain('すべてリセット: 露光量 +0.30 → 0.00');
  });

  it('includes both WB values when either WB Reset changes temperature and tint', () => {
    const step: RawHistoryStep = { stepId: '00000000-0000-4000-8000-000000000001', kind: 'controlReset',
      metadata: { control: 'wb.tint' }, createdAt: '2026-10-23T11:14:53Z', changes: [
        { control: 'wb.temp', before: 11000, after: 4875 }, { control: 'wb.tint', before: 26, after: 13 }] };
    const markup = renderToStaticMarkup(<RawEditHistory raw={rawHistory([step], 1) as never} disabled={false} onReset={() => {}} />);
    expect(markup).toContain('色温度 11000 K → 4875 K');
    expect(markup).toContain('色かぶり補正 +26 → +13');
  });
});
