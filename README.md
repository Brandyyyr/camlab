# CAMLAB · 相机实验室

一个跑在浏览器里的相机学习实验室，用 WebGL 把「机身结构、镜头成像、实拍出片」串成一条可以动手的路径。不需要安装，打开网页就能拆相机、换镜头、调参数、按快门。

内置 **44 台机身、19 支镜头、12 个拍摄场景**，机身参数按厂商官网规格逐台核对过。

## 直接打开

`camlab.html` 是完整的单文件版本，图片全部内联：

```bash
open camlab.html     # macOS
xdg-open camlab.html # Linux
```

也可以丢进任意静态服务器（Nginx / GitHub Pages / Cloudflare Pages）：

```bash
rsync -a camlab.html addons/ /var/www/camlab/
```

## 三种模式

| 模式 | 做什么 |
| --- | --- |
| **零件拆解** | 把机身拆成零件层看：卡口、传感器、低通滤镜、防抖、快门、对焦模块、接口仓……每件都写明它在做什么，以及这台机器上有没有 |
| **机身镜头** | 选机身换镜头，看法兰距、画幅、等效视角怎么影响画面；镜头结构与卡口差异都标了出来 |
| **拍摄模拟** | 真实曝光的实时取景：调光圈、快门、ISO，看景深、动态模糊、噪点怎么变；按下快门得到一张成片，可以下载 |

成片不是贴图，是实时渲染的：景深、运动模糊、噪点、色温都在着色器里算。

## 目录

```
camlab.html    单文件源码（含 12 张内联图片，打开即用）
addons/        「上传自己的照片」插件（可选，默认未接入）
  user-photos-core.js    本地估算 EV / 色温、参数映射
  user-photos-store.js   IndexedDB 存储与图片压缩
  user-photos.js         上传卡片、确认面板与菜单
README.md
```

`camlab.html` 本身不依赖任何外部文件，可以单独拷走。

## 上传自己的照片（可选插件）

`addons/` 里的三个脚本给拍摄模拟加一个「＋ 上传照片」卡片：选一张照片后，自动给出一组可用的拍摄参数（曝光、色温、景深模式、对焦距离），并能当作场景直接拍。

单文件版默认没有接入，需要在 `camlab.html` 的 `</body>` 前按顺序加三行：

```html
<script src="addons/user-photos-core.js"></script>
<script src="addons/user-photos-store.js"></script>
<script src="addons/user-photos.js"></script>
```

接入后：

- 照片只存在**当前浏览器的 IndexedDB**（库名 `camlab-user-photos`），不上传任何服务器，换浏览器或清除站点数据就没了；
- 最多 30 张，单张原图不超过 20MB，会在本地先压缩；
- 未接入或单独打开时不联网，按画面亮度推算曝光、按冷暖推算色温，再由你选一个最接近的场景模板。

## 兼容性

需要支持 WebGL 2 的现代浏览器（Chrome / Edge / Safari 16+ / Firefox）。移动端可以浏览和拆解，拍摄模拟建议用桌面端。

## 关于数据

全部计算在浏览器本地完成，断网可用。页面不发送任何埋点或统计请求。

## 协议

尚未声明开源协议。如需公开使用，可加一个（MIT / Apache-2.0 等）。
