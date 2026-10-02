import reportTheme from '../design-system/reports/theme.json';

// Canonical file/family mapping is maintained in eval-pi-design-system.
export const reportFontFaces = reportTheme.webFonts;

let embeddedCss: Promise<string> | undefined;
export function getEmbeddedReportFontCss(): Promise<string> {
  embeddedCss ??= Promise.all(reportFontFaces.map(async face => {
    const response = await fetch(face.path);
    if (!response.ok) throw new Error(`Report font unavailable: ${face.path}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return `@font-face{font-family:'${face.family}';font-style:${face.style};font-weight:${face.weight};font-display:swap;src:url(data:font/${face.format};base64,${btoa(binary)}) format('${face.format}');}`;
  })).then(faces => faces.join('\n')).catch(error => { embeddedCss = undefined; throw error; });
  return embeddedCss;
}
