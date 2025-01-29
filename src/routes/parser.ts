/**
 * Parser路由
 */
import express from 'express';
import { ParserController } from '../controllers/parser';

const router = express.Router();
export const routePath = '/parser';

// 获取Parser列表
router.get('/list', ParserController.list);

// 获取单个Parser
router.get('/:id', ParserController.get);

// 注册Parser
router.post('/register', ParserController.reg);

// 更新Parser
router.put('/:id', ParserController.update);

// 删除Parser
router.delete('/:id', ParserController.delete);

// 设置Parser关联的Gateway
router.post('/:id/gateway', ParserController.setGateway);

export default router;
