const fs = require('fs');
const path = require('path');
const { minify: minifyJS } = require('terser');
const { minify: minifyHTML } = require('html-minifier-terser');
const cssnano = require('cssnano');
const postcss = require('postcss');

// 需要压缩的文件列表
const filesToCompress = {
  js: ['background.js', 'contentmj.js', 'contentScript.js', 'popup.js'],
  html: ['popup.html'],
  css: ['popup.css', 'stylee.css']
};

// 备份原文件
function backupFile(filePath) {
  const backupPath = filePath + '.bak';
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, backupPath);
    console.log(`已备份: ${filePath} -> ${backupPath}`);
  }
}

// 压缩 JavaScript
async function compressJS(filePath) {
  try {
    const code = fs.readFileSync(filePath, 'utf8');
    const result = await minifyJS(code, {
      compress: {
        drop_console: false, // 保留 console，方便调试
        drop_debugger: true,
        pure_funcs: ['console.debug'], // 移除 console.debug
      },
      mangle: {
        reserved: ['chrome', 'document', 'window', 'location', 'localStorage'], // 保留这些全局变量名
      },
      format: {
        comments: false,
      },
    });
    
    if (result.error) {
      throw result.error;
    }
    
    fs.writeFileSync(filePath, result.code);
    const originalSize = code.length;
    const compressedSize = result.code.length;
    const ratio = ((1 - compressedSize / originalSize) * 100).toFixed(2);
    console.log(`✓ ${filePath}: ${originalSize} -> ${compressedSize} bytes (减少 ${ratio}%)`);
    return true;
  } catch (error) {
    console.error(`✗ 压缩 ${filePath} 失败:`, error.message);
    return false;
  }
}

// 压缩 HTML
async function compressHTML(filePath) {
  try {
    const code = fs.readFileSync(filePath, 'utf8');
    const result = await minifyHTML(code, {
      collapseWhitespace: true,
      removeComments: true,
      removeEmptyAttributes: true,
      removeRedundantAttributes: true,
      removeScriptTypeAttributes: true,
      removeStyleLinkTypeAttributes: true,
      minifyCSS: false, // CSS 单独压缩
      minifyJS: false, // JS 单独压缩
    });
    
    fs.writeFileSync(filePath, result);
    const originalSize = code.length;
    const compressedSize = result.length;
    const ratio = ((1 - compressedSize / originalSize) * 100).toFixed(2);
    console.log(`✓ ${filePath}: ${originalSize} -> ${compressedSize} bytes (减少 ${ratio}%)`);
    return true;
  } catch (error) {
    console.error(`✗ 压缩 ${filePath} 失败:`, error.message);
    return false;
  }
}

// 压缩 CSS
async function compressCSS(filePath) {
  try {
    const code = fs.readFileSync(filePath, 'utf8');
    const result = await postcss([cssnano({
      preset: ['default', {
        discardComments: { removeAll: true },
        normalizeWhitespace: true,
      }]
    })]).process(code, { from: filePath });
    
    fs.writeFileSync(filePath, result.css);
    const originalSize = code.length;
    const compressedSize = result.css.length;
    const ratio = ((1 - compressedSize / originalSize) * 100).toFixed(2);
    console.log(`✓ ${filePath}: ${originalSize} -> ${compressedSize} bytes (减少 ${ratio}%)`);
    return true;
  } catch (error) {
    console.error(`✗ 压缩 ${filePath} 失败:`, error.message);
    return false;
  }
}

// 主函数
async function main() {
  console.log('开始压缩文件...\n');
  
  // 压缩 JS 文件
  console.log('压缩 JavaScript 文件:');
  for (const file of filesToCompress.js) {
    if (fs.existsSync(file)) {
      backupFile(file);
      await compressJS(file);
    } else {
      console.log(`⚠ 文件不存在: ${file}`);
    }
  }
  
  console.log('\n压缩 HTML 文件:');
  for (const file of filesToCompress.html) {
    if (fs.existsSync(file)) {
      backupFile(file);
      await compressHTML(file);
    } else {
      console.log(`⚠ 文件不存在: ${file}`);
    }
  }
  
  console.log('\n压缩 CSS 文件:');
  for (const file of filesToCompress.css) {
    if (fs.existsSync(file)) {
      backupFile(file);
      await compressCSS(file);
    } else {
      console.log(`⚠ 文件不存在: ${file}`);
    }
  }
  
  console.log('\n压缩完成！');
  console.log('提示: 原文件已备份为 .bak 文件，如需恢复请手动重命名。');
}

main().catch(console.error);

