import moment from 'moment';
import 'moment-timezone';

export function getTodaysStartAndEndDate() {
  const startDate = moment().tz('Asia/Jakarta').startOf('day').format();
  const endDate = moment().tz('Asia/Jakarta').endOf('day').format();
  return {
    startDate,
    endDate,
  };
}
