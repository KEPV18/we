const { Chart } = require('chart.js/auto');
const { Canvas } = require('skia-canvas');
const fs = require('fs');
const path = require('path');
const logger = require('../logger');

// Ensure charts directory exists
const chartsDir = path.join(__dirname, '..', 'charts');
if (!fs.existsSync(chartsDir)) fs.mkdirSync(chartsDir, { recursive: true });

class ChartService {
    constructor() {
        logger.info('ChartService initialized');
    }

    /**
     * Create a usage chart configuration
     * @param {Object} data Usage data
     * @returns {Object} Chart.js configuration
     */
    getChartConfig(data) {
        const remaining = parseFloat(data.remainingGB);
        const used = parseFloat(data.usedGB);
        const total = remaining + used; // Approx total if not provided

        return {
            type: 'doughnut',
            data: {
                labels: ['المتبقي (GB)', 'المستخدم (GB)'],
                datasets: [{
                    data: [remaining, used],
                    backgroundColor: [
                        'rgba(75, 192, 192, 0.8)', // Green for remaining
                        'rgba(255, 99, 132, 0.8)'  // Red for used
                    ],
                    borderColor: [
                        'rgba(75, 192, 192, 1)',
                        'rgba(255, 99, 132, 1)'
                    ],
                    borderWidth: 1
                }]
            },
            options: {
                plugins: {
                    title: {
                        display: true,
                        text: `استهلاك الباقة (${data.plan || 'غير محدد'})`,
                        font: { size: 18 }
                    },
                    legend: {
                        position: 'bottom'
                    }
                }
            }
        };
    }

    /**
     * Generate chart image
     * @param {number|string} chatId 
     * @param {Object} data Usage data
     * @returns {Promise<string>} Path to generated image
     */
    async generateUsageChart(chatId, data) {
        const width = 800;
        const height = 600;
        const canvas = new Canvas(width, height);
        const ctx = canvas.getContext('2d');

        // Background color
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);

        const config = this.getChartConfig(data);
        const chart = new Chart(ctx, config);

        const imagePath = path.join(chartsDir, `usage-${chatId}-${Date.now()}.png`);

        try {
            await chart.render();
            const buffer = await canvas.toBuffer('png');
            fs.writeFileSync(imagePath, buffer);
            logger.info(`Chart generated at: ${imagePath}`);
            return imagePath;
        } catch (err) {
            logger.error('Error generating chart:', err);
            throw err;
        }
    }

    /**
     * Cleanup old charts
     */
    cleanupOldCharts() {
        // Logic to delete old files
        try {
            const files = fs.readdirSync(chartsDir);
            const now = Date.now();
            for (const file of files) {
                const filePath = path.join(chartsDir, file);
                const stats = fs.statSync(filePath);
                // Delete files older than 1 hour
                if (now - stats.mtimeMs > 3600000) {
                    fs.unlinkSync(filePath);
                }
            }
        } catch (err) {
            logger.error('Error cleaning up charts:', err);
        }
    }
}

module.exports = new ChartService();
