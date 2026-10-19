// src/services/onlineMusic/customSourceEngine/modules-shim.d.ts
// 插件模块表用到、但没带类型声明的三个包：插件脚本本身是无类型的，这里只要模块能被 import。
// 声明成 any 是刻意的——插件的调用形态由脚本自己决定，在这层给具体类型没有意义。

declare module 'crypto-js';
declare module 'qs';
declare module 'he';
