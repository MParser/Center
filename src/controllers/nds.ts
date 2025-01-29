/**
 * NDS控制器
 */
import { Request, Response } from 'express';
import mysql from '../database/mysql';
import logger from '../utils/logger';

export class NDSController {
    static async list(_req: Request, res: Response): Promise<void> {
        try {
            const ndsList = await mysql.ndsList.findMany();
            res.success(ndsList, '获取NDS列表成功');
        } catch (error: any) {
            logger.error('获取NDS列表失败:', error);
            res.internalError('获取NDS列表失败');
        }
    }

    static async get(req: Request, res: Response): Promise<void> {
        try {
            const id = parseInt(req.params.id);
            const nds = await mysql.ndsList.findUnique({ where: { id } });
            if (nds) {
                res.success(nds, '获取NDS成功');
            } else {
                res.notFound('NDS不存在');
            }
        } catch (error: any) {
            res.internalError('获取NDS失败');
        }
    }

    static async create(req: Request, res: Response): Promise<void> {
        try {
            const data = req.body;
            const nds = await mysql.ndsList.create({ data });
            res.success(nds, '创建NDS成功');
        } catch (error: any) {
            logger.error('创建NDS失败:', error);
            res.internalError('创建NDS失败');
        }
    }

    static async update(req: Request, res: Response): Promise<void> {
        try {
            const id = parseInt(req.params.id);
            const data = req.body;
            const nds = await mysql.ndsList.update({
                where: { id },
                data
            });
            res.success(nds, '更新NDS成功');
        } catch (error: any) {
            res.internalError('更新NDS失败');
        }
    }

    static async delete(req: Request, res: Response): Promise<void> {
        try {
            const id = parseInt(req.params.id);
            await mysql.ndsList.delete({ where: { id } });
            res.success(null, '删除NDS成功');
        } catch (error: any) {
            res.internalError('删除NDS失败');
        }
    }
}