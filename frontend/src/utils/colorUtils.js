/**
 * Extracts dominant colors from an image source (URL or Data URI).
 * @param {string} imageSrc - The source of the image.
 * @param {number} maxColors - Maximum number of colors to return.
 * @returns {Promise<string[]>} - A promise that resolves to an array of hex color strings.
 */
export const extractColorsFromImage = (imageSrc, maxColors = 5) => {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'Anonymous';
        img.src = imageSrc;

        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');

            // Resize image for faster processing but keep it large enough to catch details
            const maxSize = 200;
            let width = img.width;
            let height = img.height;

            if (width > height) {
                if (width > maxSize) {
                    height *= maxSize / width;
                    width = maxSize;
                }
            } else {
                if (height > maxSize) {
                    width *= maxSize / height;
                    height = maxSize;
                }
            }

            canvas.width = width;
            canvas.height = height;
            ctx.drawImage(img, 0, 0, width, height);

            const imageData = ctx.getImageData(0, 0, width, height).data;
            const colorCounts = new Map();

            for (let i = 0; i < imageData.length; i += 4) {
                const r = imageData[i];
                const g = imageData[i + 1];
                const b = imageData[i + 2];
                const a = imageData[i + 3];

                // Skip transparent or semi-transparent pixels
                if (a < 128) continue;

                const hex = rgbToHex(r, g, b);
                colorCounts.set(hex, (colorCounts.get(hex) || 0) + 1);
            }

            // Sort by frequency
            const sortedColors = [...colorCounts.entries()]
                .sort((a, b) => b[1] - a[1]);

            const distinctColors = [];
            // Euclidean distance threshold to consider colors "similar"
            // 30-40 is usually a good balance. 
            // sqrt(255^2 + 255^2 + 255^2) approx 441. 
            // 40 is about 10% difference.
            const threshold = 40;

            for (const [hex] of sortedColors) {
                const rgb = hexToRgb(hex);
                let isSimilar = false;

                for (const existingHex of distinctColors) {
                    const existingRgb = hexToRgb(existingHex);
                    const dist = Math.sqrt(
                        Math.pow(rgb.r - existingRgb.r, 2) +
                        Math.pow(rgb.g - existingRgb.g, 2) +
                        Math.pow(rgb.b - existingRgb.b, 2)
                    );

                    if (dist < threshold) {
                        isSimilar = true;
                        break;
                    }
                }

                if (!isSimilar) {
                    distinctColors.push(hex);
                }

                if (distinctColors.length >= maxColors) break;
            }

            resolve(distinctColors);
        };

        img.onerror = (err) => {
            reject(err);
        };
    });
};

const componentToHex = (c) => {
    const hex = c.toString(16);
    return hex.length === 1 ? "0" + hex : hex;
};

const rgbToHex = (r, g, b) => {
    return "#" + componentToHex(r) + componentToHex(g) + componentToHex(b);
};

const hexToRgb = (hex) => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    } : { r: 0, g: 0, b: 0 };
};

/**
 * Determines if a color is light or dark.
 * @param {string} hexColor - The hex color string.
 * @returns {'light' | 'dark'}
 */
export const getContrastMode = (hexColor) => {
    const hex = hexColor.replace('#', '');
    const r = parseInt(hex.substr(0, 2), 16);
    const g = parseInt(hex.substr(2, 2), 16);
    const b = parseInt(hex.substr(4, 2), 16);

    // Calculate relative luminance
    const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
    return (yiq >= 128) ? 'light' : 'dark';
};
