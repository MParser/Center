import express, { Express, Request, Response } from 'express';
import { config } from './utils/config';
import logger from "./utils/logger";
import { responseHandler } from './middleware/response';
import { requestHandler } from './middleware/request';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './utils/swagger';
import fs from 'fs';
import path from 'path';

// 创建Express应用实例
const app: Express = express();

// 从配置文件加载端口
const port: number = config.get('app.port', 9002);

// 基础中间件配置
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// 日志中间件
app.use((req: Request, _res: Response, next) => {
    logger.debug(`${req.method} ${req.url}`);
    next();
});

// 添加请求处理中间件（要在其他中间件之前）
app.use(requestHandler);

// 添加响应处理中间件
app.use(responseHandler);

// API 文档
app.get('/openapi.json', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
});

const swaggerOptions = {
    explorer: true,
    customSiteTitle: "MParser Center API 文档",
    swaggerOptions: {
        urls: [
            {
                url: '/openapi.json',
                name: 'MParser Center API'
            }
        ]
    }
};

app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, swaggerOptions));

// 自动加载路由
const routesDir = path.join(__dirname, 'routes');
fs.readdirSync(routesDir).forEach(async (file) => {
    // 开发环境加载.ts文件，生产环境加载.js文件
    if (file.endsWith('.d.ts')) {
        logger.info(`忽略路由文件 ${file}`);
        return;
    }

    try {
    // 动态导入路由模块
    const routeModule = await import(path.join(routesDir, file));
    const router = routeModule.default;

    if (router) {
        // 优先使用模块中定义的路由路径，如果没有则使用文件名
        const routePath = routeModule.routePath || `/${path.parse(file).name}`;
        // 注册路由
        app.use(`/api${routePath}`, router);
        logger.info(`已加载路由: ${routePath} (${file})`);
    }
    } catch (error) {
    logger.error(`加载路由失败 ${file}:`, error);
    }
});

// 根路由
app.get('/', (_req: Request, res: Response) => {
    // 从配置中获取应用名称
  const appName = config.get('app.name', 'MParser Center');
  res.success({ name: appName }, `${appName} 服务已启动`);
});

// 启动服务器
app.listen(port, () => {
  logger.info(`服务器已启动，监听端口 ${port}`);
});
