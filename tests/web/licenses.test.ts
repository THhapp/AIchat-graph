import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import projectLicense from '../../LICENSE?raw';
import thirdPartyNotices from '../../THIRD_PARTY_NOTICES.txt?raw';
import { LicenseNotices } from '../../src/web/components/LicenseNotices.js';

describe('bundled license notices', () => {
  it('retains both complete texts and labels the modal with keyboard-close support', () => {
    const html = renderToStaticMarkup(createElement(LicenseNotices));

    expect(projectLicense).toContain('MIT License');
    expect(thirdPartyNotices.trim().length).toBeGreaterThan(0);
    expect(html).toContain(renderToStaticMarkup(createElement('pre', null, projectLicense)));
    expect(html).toContain(renderToStaticMarkup(createElement('pre', null, thirdPartyNotices)));
    expect(html).toContain('aria-haspopup="dialog"');
    const titleId = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
    expect(titleId).toBeDefined();
    expect(html).toContain('<h2 id="' + titleId + '">开源许可</h2>');
    expect(html).toContain('<form method="dialog">');
    expect(html).toContain('aria-label="关闭开源许可"');
    expect(html).not.toMatch(/<dialog[^>]*\sopen(?:=|\s|>)/);
  });
});
