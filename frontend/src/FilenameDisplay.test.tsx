import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FilenameDisplay, splitFilename } from './FilenameDisplay';

describe('FilenameDisplay', () => {
  it.each([
    ['photo.jpg', 'photo.jpg', ''],
    ['PXL_20260402_105016.jpg', 'PXL_20260402', '_105016.jpg'],
    ['PXL_20260402_105016-Genzo01.jpg', 'PXL_20260402_105016', '-Genzo01.jpg'],
    ['DSC_1234-Lr.jpg', 'DSC_1234-Lr.jpg', ''],
    ['IMG_0001-edit-final.jpg', 'IMG_0001-edit', '-final.jpg'],
    ['vacation-retouched-final-v2.jpeg', 'vacation-retouched-final', '-v2.jpeg'],
    ['manual-created-file.png', 'manual-created', '-file.png'],
  ])('splits %s while preserving useful ending text', (filename, prefix, suffix) => {
    expect(splitFilename(filename)).toEqual({ prefix, suffix });
    expect(prefix + suffix).toBe(filename);
  });

  it('keeps the full filename available to tooltip and assistive technology', () => {
    const filename = 'PXL_20260402_105016-Genzo01.jpg';
    const markup = renderToStaticMarkup(<FilenameDisplay filename={filename} />);
    expect(markup).toContain(`title="${filename}"`);
    expect(markup).toContain('class="filename-suffix">-Genzo01.jpg</span>');
    expect(markup).not.toContain('...');
  });
});
