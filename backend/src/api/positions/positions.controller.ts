import { Controller, Get, Param } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Position, PositionStatus } from '../../entities/position.entity';

@Controller('api/positions')
export class PositionsController {
  constructor(
    @InjectRepository(Position)
    private readonly positionRepo: Repository<Position>,
  ) {}

  @Get()
  async getAllPositions() {
    return await this.positionRepo.find({
      order: { entry_time: 'DESC' },
    });
  }

  @Get('active')
  async getActivePositions() {
    return await this.positionRepo.find({
      where: { status: PositionStatus.ACTIVE },
      order: { entry_time: 'DESC' },
    });
  }

  @Get(':positionId')
  async getPositionById(@Param('positionId') positionId: string) {
    return await this.positionRepo.findOne({
      where: { position_id: positionId },
    });
  }
}
