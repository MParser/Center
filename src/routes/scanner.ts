/**
 * Scanner路由
 */
import express from 'express';
import { ScannerController } from '../controllers/scanner';

const router = express.Router();
export const routePath = '/scanner';

// 获取Scanner列表
router.get('/list', ScannerController.list);

// 获取单个Scanner
router.get('/:id', ScannerController.get);

// 注册Scanner
router.post('/register', ScannerController.reg);

// 更新Scanner
router.put('/:id', ScannerController.update);

// 删除Scanner
router.delete('/:id', ScannerController.delete);

// 设置Scanner关联的Gateway
router.post('/:id/gateway', ScannerController.setGateway);

// 设置Scanner关联的NDS
router.post('/:id/nds', ScannerController.setNDS);

export default router;
