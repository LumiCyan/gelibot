/**
 * electron-builder 配置。
 *
 * 注意：electron-builder 默认会去 GitHub 下载 electron 压缩包与 winCodeSign/nsis 工具链，
 * 在受限网络下必然超时。这里统一指向 npmmirror 镜像，并且复用项目内已经下好的
 * electron 二进制（electronDist），避免重复下载。
 */
module.exports = {
  appId: 'cn.gelibot.bridge',
  productName: 'GeLi Bot',
  copyright: 'Copyright © 2026 GeLi Bot',

  // 直接用项目内已解压好的 electron，省掉一次 100MB+ 的下载
  electronDist: 'node_modules/electron/dist',
  electronVersion: '33.4.11',

  directories: {
    // 注意：打包前需要目录为空。若上一次产物还在且被占用，
    // electron-builder 的清理步骤会失败——改个 output 名或先手动移走即可。
    output: process.env.GC_OUT_DIR || 'dist-release',
    buildResources: 'build',
  },

  // 只打包运行必需的文件，源码/测试/截图一律不进包
  files: [
    'dist/**/*',
    'package.json',
    '!**/*.map',
  ],

  /**
   * SnowLuma 运行包直接铺到 resources/snowluma/。
   *
   * 它是独立进程（自带 node.exe），不参与 asar 打包，所以放 extraResources 而不是 files。
   * 因为有 97 MB，portable 目标会把它一起压进 app-64.7z，exe 大约会涨 33 MB。
   */
  extraResources: [
    {
      from: 'snowluma',
      to: 'snowluma',
      filter: ['**/*'],
    },
  ],

  extraMetadata: {
    main: 'dist/main/main.js',
    // 必须显式写进 app.asar 的 package.json：
    // Electron 的 app.getPath('userData') = %APPDATA%/<productName | name>，
    // 少了这一项会退化成小写的 name，数据目录就跟产品名对不上了。
    productName: 'GeLi Bot',
  },

  asar: true,
  compression: 'maximum',

  win: {
    // 单文件绿色版，双击即用，无需安装
    target: [
      { target: 'portable', arch: ['x64'] },
    ],
    artifactName: 'GeLi Bot v${version}.${ext}',
    icon: 'build/icon.ico',
    // 没有签名证书，跳过签名环节（否则会尝试下载 winCodeSign）
    signAndEditExecutable: false,
  },

  portable: {
    artifactName: 'GeLi Bot v${version}.${ext}',
    // portable 运行时把应用解到这个临时目录；不要带空格，避免个别环境路径处理出问题
    unpackDirName: 'GeLiBot',
  },

  // 关闭自动更新相关逻辑，避免打包时联网检查
  publish: null,
};
