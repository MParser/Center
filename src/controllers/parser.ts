/**
 * Parser控制器
 */
import { Request, Response } from 'express';
import mysql from '../database/mysql';
import logger from '../utils/logger';

interface SetGatewayRequestBody {
    gatewayId: string;
}

export class ParserController {
    static async list(_req: Request, res: Response): Promise<void> {
        try {
            const parsers = await mysql.parserList.findMany({
                include: {
                    gateway: true
                }
            });
            res.success(parsers, '获取Parser列表成功');
        } catch (error: any) {
            logger.error('获取Parser列表失败:', error);
            res.internalError('获取Parser列表失败');
        }
    }

    static async get(req: Request, res: Response): Promise<void> {
        try {
            const id = req.params.id;
            const parser = await mysql.parserList.findUnique({ 
                where: { id },
                include: {
                    gateway: true
                }
            });
            if (parser) {
                res.success(parser, '获取Parser成功');
            } else {
                res.notFound('Parser不存在');
            }
        } catch (error: any) {
            res.internalError('获取Parser失败');
        }
    }

    static async reg(req: Request, res: Response): Promise<void> {
        try {
            const data = req.body;
            
            // 先判断Parser是否存在
            const parser = await mysql.parserList.findUnique({ where: { id: data.id } });
            if (parser) {
                // 存在则更新Parser状态(status = 1)以及port端口
                await mysql.parserList.update({
                    where: { id: data.id },
                    data: { status: 1, port: data.port }
                });
                res.success(parser, '注册Parser成功');
            } else {
                // 不存在则添加Parser,从req.requestInfo中获取IP地址，添加进data中
                data.host = req.requestInfo.ip;
                data.switch = 0;
                const newParser = await mysql.parserList.create({ data });
                res.success(newParser, "注册Parser成功");
            }
        } catch (error: any) {
            logger.error('注册Parser失败:', error);
            res.internalError('注册Parser失败');
        }
    }

    static async update(req: Request, res: Response): Promise<void> {
        try {
            const id = req.params.id;
            const data = req.body;
            
            // 如果要更新gatewayId，先验证Gateway是否存在
            if (data.gatewayId) {
                const gateway = await mysql.gatewayList.findUnique({ 
                    where: { id: data.gatewayId } 
                });
                
                if (!gateway) {
                    return res.badRequest('指定的Gateway不存在');
                }
            }

            const parser = await mysql.parserList.update({
                where: { id },
                data,
                include: {
                    gateway: true
                }
            });
            res.success(parser, '更新Parser成功');
        } catch (error: any) {
            logger.error('更新Parser失败:', error);
            res.internalError('更新Parser失败');
        }
    }

    static async delete(req: Request, res: Response): Promise<void> {
        try {
            const id = req.params.id;
            await mysql.parserList.delete({ where: { id } });
            res.success(null, '删除Parser成功');
        } catch (error: any) {
            logger.error('删除Parser失败:', error);
            res.internalError('删除Parser失败');
        }
    }

    /**
     * 设置Parser关联的Gateway
     */
    static async setGateway(req: Request<{ id: string }, any, SetGatewayRequestBody>, res: Response): Promise<void> {
        try {
            const parserId = req.params.id;
            const { gatewayId } = req.body;

            // 验证Parser是否存在
            const parser = await mysql.parserList.findUnique({ where: { id: parserId } });
            if (!parser) {
                return res.notFound('Parser不存在');
            }

            // 验证Gateway是否存在
            const gateway = await mysql.gatewayList.findUnique({ where: { id: gatewayId } });
            if (!gateway) {
                return res.badRequest('指定的Gateway不存在');
            }

            // 更新Parser的Gateway
            const updatedParser = await mysql.parserList.update({
                where: { id: parserId },
                data: { gatewayId },
                include: {
                    gateway: true
                }
            });

            res.success(updatedParser, '设置Parser Gateway成功');
        } catch (error: any) {
            logger.error('设置Parser Gateway失败:', error);
            res.internalError('设置Parser Gateway失败');
        }
    }
}
