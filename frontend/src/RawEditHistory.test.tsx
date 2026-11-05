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

  it.each(['ja', 'en'])('labels Vignette modes and its independent Reset in %s', async language => {
    await i18n.changeLanguage(language);
    const steps: RawHistoryStep[] = [
      ...(['highlightPriority', 'colorPriority', 'paintOverlay'] as const).map(style => ({ stepId: style, kind: 'vignetteStyle' as const,
        metadata: { style }, changes: [], createdAt: '2026-10-28T00:00:00Z' })),
      { stepId: 'reset', kind: 'sectionReset', metadata: { section: 'vignette' }, changes: [{ control: 'vignette.amount', before: -73, after: 0 }], createdAt: '2026-10-28T00:00:00Z' },
    ];
    const markup = renderToStaticMarkup(<RawEditHistory raw={rawHistory(steps, 4) as never} disabled={false} onReset={() => {}} />);
    for (const label of language === 'ja' ? ['ハイライト', 'カラー', 'ペイント', '周辺光量補正 リセット'] : ['Highlight', 'Color', 'Paint', 'Vignette Reset']) expect(markup).toContain(label);
    expect(markup).toContain('-73 → 0'); expect(markup).not.toContain('workspace.');
  });

  it.each(['ja', 'en'])('distinguishes Effects toggle from Basic Effects Reset and formats all three values in %s', async language => {
    await i18n.changeLanguage(language);
    const controls = ['effects.texture', 'effects.clarity', 'effects.dehaze'] as const;
    const steps: RawHistoryStep[] = controls.flatMap((control, index) => [
      { stepId: `${index}-edit`, kind: 'control', metadata: { control }, createdAt: '2026-10-27T00:00:00Z', changes: [{ control, before: -40, after: 73 }] },
      { stepId: `${index}-reset`, kind: 'controlReset', metadata: { control }, createdAt: '2026-10-27T00:00:00Z', changes: [{ control, before: 73, after: 0 }] },
    ]);
    steps.push({ stepId: 'off', kind: 'sectionToggle', metadata: { section: 'effects', enabled: false }, createdAt: '2026-10-27T00:00:00Z', changes: [] },
      { stepId: 'reset', kind: 'sectionReset', metadata: { section: 'effects' }, createdAt: '2026-10-27T00:00:00Z',
        changes: controls.map(control => ({ control, before: 73, after: 0 })) });
    const markup = renderToStaticMarkup(<RawEditHistory raw={rawHistory(steps, steps.length) as never} disabled={false} onReset={() => {}} />);
    expect(markup).toContain(language === 'ja' ? 'エフェクト OFF' : 'Effects OFF');
    expect(markup).toContain(language === 'ja' ? '基本エフェクト リセット' : 'Basic Effects Reset');
    for (const label of language === 'ja' ? ['テクスチャ', '明瞭度', 'かすみの除去'] : ['Texture', 'Clarity', 'Dehaze']) expect(markup).toContain(label);
    expect(markup).toContain('-40 → 73'); expect(markup).toContain('73 → 0'); expect(markup).not.toContain('workspace.');
  });

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


it.each(['ja', 'en'])('labels RAW grading controls and category Reset in %s', async language => {
  await i18n.changeLanguage(language);
  const steps: RawHistoryStep[] = [
    { stepId: 'hue', kind: 'control', metadata: { control: 'grading.midtones.hue' }, createdAt: '', changes: [{ control: 'grading.midtones.hue', before: 0, after: 360 }] },
    { stepId: 'blend', kind: 'controlReset', metadata: { control: 'grading.blending' }, createdAt: '', changes: [{ control: 'grading.blending', before: 73, after: 50 }] },
    { stepId: 'reset', kind: 'sectionReset', metadata: { section: 'grading' }, createdAt: '', changes: [] },
  ];
  const markup = renderToStaticMarkup(<RawEditHistory raw={rawHistory(steps, 3) as never} disabled={false} onReset={() => {}} />);
  expect(markup).toContain('0° → 360°'); expect(markup).toContain('73 → 50');
  expect(markup).toContain(language === 'ja' ? 'カラーグレーディング リセット' : 'Color Grading Reset');
  expect(markup).not.toContain('workspace.');
});

it.each(['ja','en'])('labels geometry History independently of scalar Reset in %s',async(language)=>{
  await i18n.changeLanguage(language);
  const steps:RawHistoryStep[]=[{stepId:'crop',kind:'geometry',metadata:{operation:'drag'},changes:[],createdAt:'2026-11-04T00:00:00Z'}];
  const markup=renderToStaticMarkup(<RawEditHistory raw={rawHistory(steps,1) as never} disabled={false} onReset={()=>{}}/>);
  expect(markup).toContain(language==='ja'?'切り抜き移動・サイズ変更':'Crop move / resize');expect(markup).not.toContain('workspace.');
});

it.each(['ja','en'])('distinguishes move/resize and lock/unlock metadata in %s',async language=>{
 await i18n.changeLanguage(language);
 const steps:RawHistoryStep[]=(['move','resize','lock','unlock'] as const).map(action=>({stepId:action,kind:'geometry',metadata:{operation:action==='move'||action==='resize'?'drag':'aspect',action},changes:[],createdAt:'2026-11-04T00:00:00Z'}));
 const markup=renderToStaticMarkup(<RawEditHistory raw={rawHistory(steps,4) as never} disabled={false} onReset={()=>{}}/>);
 for(const label of language==='en'?['Crop Move','Crop Resize','Aspect Lock','Aspect Unlock']:['切り抜き移動','切り抜きサイズ変更','縦横比の固定','縦横比の固定解除'])expect(markup).toContain(label);
});

it.each(['ja', 'en'])('uses registered Optics labels for controls, resets, flags, and section operations in %s', async language => {
  await i18n.changeLanguage(language);
  const controls = [
    ['optics.distortion', ['ゆがみ', 'Distortion'], ['ゆがみをリセット', 'Reset distortion']],
    ['optics.vignetting', ['周辺光量補正', 'Vignetting'], ['周辺光量補正をリセット', 'Reset vignetting']],
    ['optics.vignettingMidpoint', ['中心点', 'Midpoint'], ['中心点をリセット', 'Reset vignetting midpoint']],
    ['optics.profileDistortion', ['ゆがみ補正量', 'Profile Distortion'], ['ゆがみ補正量をリセット', 'Reset profile distortion']],
    ['optics.profileVignetting', ['周辺光量補正量', 'Profile Vignetting'], ['周辺光量補正量をリセット', 'Reset profile vignetting']],
    ['optics.defringePurple', ['パープルの適用量', 'Purple Amount'], ['パープルの適用量をリセット', 'Reset purple amount']],
    ['optics.defringePurpleHueLo', ['パープルの色相下限', 'Purple Hue Lower Bound'], ['パープルの色相下限をリセット', 'Reset purple hue lower bound']],
    ['optics.defringePurpleHueHi', ['パープルの色相上限', 'Purple Hue Upper Bound'], ['パープルの色相上限をリセット', 'Reset purple hue upper bound']],
    ['optics.defringeGreen', ['グリーンの適用量', 'Green Amount'], ['グリーンの適用量をリセット', 'Reset green amount']],
    ['optics.defringeGreenHueLo', ['グリーンの色相下限', 'Green Hue Lower Bound'], ['グリーンの色相下限をリセット', 'Reset green hue lower bound']],
    ['optics.defringeGreenHueHi', ['グリーンの色相上限', 'Green Hue Upper Bound'], ['グリーンの色相上限をリセット', 'Reset green hue upper bound']],
    ['optics.caRed', ['赤／シアンのフリンジ', 'Red/Cyan Fringing'], ['赤／シアン補正をリセット', 'Reset red/cyan correction']],
    ['optics.caBlue', ['青／黄のフリンジ', 'Blue/Yellow Fringing'], ['青／黄補正をリセット', 'Reset blue/yellow correction']],
  ] as const;
  const steps: RawHistoryStep[] = controls.flatMap(([control], index) => [
    { stepId: `${index}-edit`, kind: 'control', metadata: { control }, createdAt: '', changes: [{ control, before: 0, after: 1 }] },
    { stepId: `${index}-reset`, kind: 'controlReset', metadata: { control }, createdAt: '', changes: [{ control, before: 1, after: 0 }] },
  ]);
  steps.push(
    { stepId: 'remove-ca', kind: 'opticsFlag', metadata: { control: 'optics.remove_ca', enabled: true }, createdAt: '',
      changes: [], flagChanges: [{ control: 'optics.remove_ca', before: false, after: true }] },
    { stepId: 'lens-profile', kind: 'opticsFlag', metadata: { control: 'optics.lens_profile', enabled: false }, createdAt: '',
      changes: [], flagChanges: [{ control: 'optics.lens_profile', before: true, after: false }] },
    { stepId: 'remove-ca-reset', kind: 'opticsFlagReset', metadata: { control: 'optics.remove_ca' }, createdAt: '',
      changes: [], flagChanges: [{ control: 'optics.remove_ca', before: true, after: false }] },
    { stepId: 'lens-profile-reset', kind: 'opticsFlagReset', metadata: { control: 'optics.lens_profile' }, createdAt: '',
      changes: [], flagChanges: [{ control: 'optics.lens_profile', before: true, after: false }] },
    { stepId: 'section-off', kind: 'sectionToggle', metadata: { section: 'optics', enabled: false }, createdAt: '', changes: [] },
    { stepId: 'section-reset', kind: 'sectionReset', metadata: { section: 'optics' }, createdAt: '', changes: [
      { control: 'optics.distortion', before: 1, after: 0 }, { control: 'optics.caRed', before: 2, after: 0 },
    ] },
  );
  const markup = renderToStaticMarkup(<RawEditHistory raw={rawHistory(steps, steps.length) as never} disabled={false} onReset={() => {}} />);
  const localeIndex = language === 'ja' ? 0 : 1;
  for (const [, label, reset] of controls) {
    expect(markup).toContain(label[localeIndex]);
    expect(markup).toContain(reset[localeIndex]);
  }
  for (const label of language === 'ja'
    ? ['色収差を除去 OFF → ON', 'レンズ補正を有効にする ON → OFF', '色収差除去をリセット ON → OFF',
      'レンズ補正をリセット ON → OFF', 'レンズ補正 OFF', 'レンズ補正をリセット:']
    : ['Remove Chromatic Aberration OFF → ON', 'Enable Profile Corrections ON → OFF', 'Reset chromatic aberration removal ON → OFF',
      'Reset profile corrections ON → OFF', 'Lens Corrections OFF', 'Reset lens corrections:']) expect(markup).toContain(label);
  expect(markup).not.toContain('rawPreview.opticsControls');
  expect(markup).not.toContain('workspace.');
});
