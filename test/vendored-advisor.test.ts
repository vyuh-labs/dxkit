import { describe, it, expect } from 'vitest';
import { looksVendored, suspectVendoredEntries } from '../src/analyzers/tools/vendored-advisor';

describe('looksVendored', () => {
  it('flags /libs/ paths (most-common customer-specific vendored case)', () => {
    expect(
      looksVendored('public/richtexteditor/libs/colorpicker/js/bootstrap-colorpicker.js'),
    ).toBe(true);
    expect(looksVendored('apps/web/libs/lexical/editor.js')).toBe(true);
  });

  it('flags playground and lexical-playground subtrees', () => {
    expect(
      looksVendored(
        'src/components/Notes/notecomponents/lexical-playground/src/utils/emoji-list.ts',
      ),
    ).toBe(true);
    expect(looksVendored('src/playground/sample.tsx')).toBe(true);
  });

  it('flags third-party / third_party / vendored / external / _vendor conventions', () => {
    expect(looksVendored('third_party/jsoncpp/jsoncpp.cc')).toBe(true);
    expect(looksVendored('apps/something/third-party/lib.js')).toBe(true);
    expect(looksVendored('vendored/colorpicker.js')).toBe(true);
    expect(looksVendored('src/_vendor/library.js')).toBe(true);
    expect(looksVendored('packages/external/widget.js')).toBe(true);
  });

  it('flags colorpicker and bundled conventions', () => {
    expect(looksVendored('public/assets/colorpicker/js/picker.js')).toBe(true);
    expect(looksVendored('dist/bundled/main.js')).toBe(true);
  });

  it('flags map-library vendored bundles (mapbox-gl, leaflet, cesium)', () => {
    expect(looksVendored('public/map/js/mapbox-gl.js')).toBe(true);
    expect(looksVendored('vendor/leaflet/leaflet.min.js')).toBe(true);
    expect(looksVendored('lib/cesium/Cesium.js')).toBe(true);
  });

  it('flags SAP B1 / OData proxy classes (WinForms SAP-integration case)', () => {
    expect(looksVendored('app/vendor/sapb1/billing/Invoice.cs')).toBe(true);
    expect(looksVendored('app/vendor/sapbyd/services/Sales.cs')).toBe(true);
    expect(looksVendored('app/generated/odata/Customer.cs')).toBe(true);
  });

  it('flags connected-services / proto-generated conventions', () => {
    expect(looksVendored('Code/Source/ConnectedServices/SAP/Reference.cs')).toBe(true);
    expect(looksVendored('src/grpcGenerated/UserService.ts')).toBe(true);
    expect(looksVendored('src/protoGenerated/messages.go')).toBe(true);
  });

  it('does not false-positive on filenames containing vendored tokens', () => {
    // Files NAMED like vendored conventions but living in normal source
    // directories should NOT trigger the advisory.
    expect(looksVendored('src/utils/libs-helper.ts')).toBe(false);
    expect(looksVendored('src/components/PlaygroundButton.tsx')).toBe(false);
    expect(looksVendored('src/vendored-types.ts')).toBe(false);
  });

  it('case-insensitive on path segments', () => {
    expect(looksVendored('Public/LIBS/Editor.js')).toBe(true);
    expect(looksVendored('src/Third_Party/lib.js')).toBe(true);
  });
});

describe('suspectVendoredEntries', () => {
  it('returns only the suspect-vendored subset', () => {
    const files = [
      { path: 'src/app.ts', lines: 1000 },
      { path: 'public/libs/colorpicker.js', lines: 6000 },
      { path: 'src/components/Foo.tsx', lines: 500 },
      { path: 'third_party/lib.js', lines: 9000 },
    ];
    const out = suspectVendoredEntries(files);
    expect(out.map((f) => f.path)).toEqual(['public/libs/colorpicker.js', 'third_party/lib.js']);
  });

  it('returns empty when nothing matches', () => {
    expect(
      suspectVendoredEntries([
        { path: 'src/a.ts', lines: 100 },
        { path: 'src/b.ts', lines: 200 },
      ]),
    ).toEqual([]);
  });
});
