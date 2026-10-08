import React, { useState, useMemo } from 'react';
import {
    Box,
    Button,
    IconButton,
    InputAdornment,
    MenuItem,
    Popover,
    Select,
    Stack,
    TextField,
    Typography,
} from '@mui/material';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';

interface SkerryDatePickerProps {
    label?: string;
    value?: string;
    onChange: (value: string) => void;
    fullWidth?: boolean;
    disabled?: boolean;
    error?: boolean;
    helperText?: React.ReactNode;
    placeholder?: string;
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

const pad2 = (n: number) => String(n).padStart(2, '0');

const formatDateString = (year: number, month: number, day: number) =>
    year + '-' + pad2(month + 1) + '-' + pad2(day);

const parseDateString = (val?: string): { year: number; month: number; day: number } | null => {
    if (!val) return null;
    const normalized = val.replace(/\//g, '-').trim();
    const parts = normalized.split('-');
    if (parts.length >= 3) {
        const year = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10) - 1;
        const day = parseInt(parts[2], 10);
        if (!isNaN(year) && !isNaN(month) && !isNaN(day) && month >= 0 && month <= 11) {
            return { year, month, day };
        }
    }
    return null;
};

export function SkerryDatePicker({
    label,
    value = '',
    onChange,
    fullWidth = false,
    disabled = false,
    error = false,
    helperText,
    placeholder = 'YYYY-MM-DD',
}: SkerryDatePickerProps) {
    const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
    const [view, setView] = useState<'days' | 'years'>('days');

    const parsed = useMemo(() => parseDateString(value), [value]);

    const today = useMemo(() => new Date(), []);
    const [navYear, setNavYear] = useState<number>(parsed?.year ?? today.getFullYear());
    const [navMonth, setNavMonth] = useState<number>(parsed?.month ?? today.getMonth());
    const [yearPage, setYearPage] = useState<number>(Math.floor((parsed?.year ?? today.getFullYear()) / 12) * 12);

    const handleOpen = (event: React.MouseEvent<HTMLElement>) => {
        if (disabled) return;
        const current = parseDateString(value) || {
            year: today.getFullYear(),
            month: today.getMonth(),
            day: today.getDate(),
        };
        setNavYear(current.year);
        setNavMonth(current.month);
        setYearPage(Math.floor(current.year / 12) * 12);
        setView('days');
        setAnchorEl(event.currentTarget);
    };

    const handleClose = () => {
        setAnchorEl(null);
        setView('days');
    };

    const isOpen = Boolean(anchorEl);

    const handlePrevMonth = () => {
        if (navMonth === 0) {
            setNavMonth(11);
            setNavYear((y) => y - 1);
        } else {
            setNavMonth((m) => m - 1);
        }
    };

    const handleNextMonth = () => {
        if (navMonth === 11) {
            setNavMonth(0);
            setNavYear((y) => y + 1);
        } else {
            setNavMonth((m) => m + 1);
        }
    };

    const calendarDays = useMemo(() => {
        const firstDayIndex = new Date(navYear, navMonth, 1).getDay();
        const daysInMonth = new Date(navYear, navMonth + 1, 0).getDate();
        const daysInPrevMonth = new Date(navYear, navMonth, 0).getDate();

        const cells: Array<{
            year: number;
            month: number;
            day: number;
            isCurrentMonth: boolean;
        }> = [];

        for (let i = firstDayIndex - 1; i >= 0; i--) {
            const prevMonth = navMonth === 0 ? 11 : navMonth - 1;
            const prevYear = navMonth === 0 ? navYear - 1 : navYear;
            cells.push({
                year: prevYear,
                month: prevMonth,
                day: daysInPrevMonth - i,
                isCurrentMonth: false,
            });
        }

        for (let day = 1; day <= daysInMonth; day++) {
            cells.push({
                year: navYear,
                month: navMonth,
                day,
                isCurrentMonth: true,
            });
        }
        const totalNeeded = cells.length > 35 ? 42 : 35;
        const extra = totalNeeded - cells.length;
        for (let day = 1; day <= extra; day++) {
            const nextMonth = navMonth === 11 ? 0 : navMonth + 1;
            const nextYear = navMonth === 11 ? navYear + 1 : navYear;
            cells.push({
                year: nextYear,
                month: nextMonth,
                day,
                isCurrentMonth: false,
            });
        }

        return cells;
    }, [navYear, navMonth]);

    const handleSelectDay = (year: number, month: number, day: number) => {
        onChange(formatDateString(year, month, day));
        handleClose();
    };

    const handleToday = () => {
        onChange(formatDateString(today.getFullYear(), today.getMonth(), today.getDate()));
        handleClose();
    };

    const handleClear = () => {
        onChange('');
        handleClose();
    };

    const yearsList = useMemo(() => {
        const list = [];
        for (let y = yearPage; y < yearPage + 12; y++) {
            list.push(y);
        }
        return list;
    }, [yearPage]);

    return (
        <>
            <TextField
                label={label}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                fullWidth={fullWidth}
                disabled={disabled}
                error={error}
                helperText={helperText}
                InputProps={{
                    endAdornment: (
                        <InputAdornment position='end'>
                            <IconButton
                                size='small'
                                edge='end'
                                onClick={handleOpen}
                                disabled={disabled}
                                sx={{ color: 'text.secondary' }}
                            >
                                <CalendarMonthIcon fontSize='small' />
                            </IconButton>
                        </InputAdornment>
                    ),
                }}
            />

            <Popover
                open={isOpen}
                anchorEl={anchorEl}
                onClose={handleClose}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                transformOrigin={{ vertical: 'top', horizontal: 'right' }}
                PaperProps={{
                    sx: {
                        p: 1.5,
                        width: 290,
                        background: 'var(--skerry-glass-surface, #1e293b)',
                        backdropFilter: 'blur(24px) saturate(140%)',
                        border: '1px solid var(--skerry-glass-border, rgba(255, 255, 255, 0.12))',
                        borderRadius: 1,
                        boxShadow: '0 16px 40px rgba(0, 0, 0, 0.4)',
                        userSelect: 'none',
                    },
                }}
            >
                <Stack direction='row' alignItems='center' justifyContent='space-between' sx={{ mb: 1.5 }}>
                    <IconButton
                        size='small'
                        onClick={view === 'days' ? handlePrevMonth : () => setYearPage((p) => p - 12)}
                    >
                        <ChevronLeftIcon fontSize='small' />
                    </IconButton>

                    <Button
                        size='small'
                        variant='text'
                        onClick={() => setView((v) => (v === 'days' ? 'years' : 'days'))}
                        sx={{
                            fontWeight: 700,
                            fontSize: '0.95rem',
                            color: 'text.primary',
                            textTransform: 'none',
                        }}
                    >
                        {view === 'days' ? String(navYear) + '年 ' + String(navMonth + 1) + '月' : String(yearPage) + ' - ' + String(yearPage + 11)}
                    </Button>

                    <IconButton
                        size='small'
                        onClick={view === 'days' ? handleNextMonth : () => setYearPage((p) => p + 12)}
                    >
                        <ChevronRightIcon fontSize='small' />
                    </IconButton>
                </Stack>

                {view === 'days' ? (
                    <>
                        <Box
                            sx={{
                                display: 'grid',
                                gridTemplateColumns: 'repeat(7, 32px)',
                                justifyContent: 'center',
                                textAlign: 'center',
                                gap: '4px',
                                mb: 1,
                            }}
                        >
                            {WEEKDAYS.map((wd) => (
                                <Typography key={wd} variant='caption' color='text.secondary' fontWeight={600} sx={{ width: 32, textAlign: 'center' }}>
                                    {wd}
                                </Typography>
                            ))}
                        </Box>

                        <Box
                            sx={{
                                display: 'grid',
                                gridTemplateColumns: 'repeat(7, 32px)',
                                justifyContent: 'center',
                                gap: '4px',
                            }}
                        >
                            {calendarDays.map((cell, idx) => {
                                const isSelected =
                                    parsed &&
                                    parsed.year === cell.year &&
                                    parsed.month === cell.month &&
                                    parsed.day === cell.day;
                                const isToday =
                                    today.getFullYear() === cell.year &&
                                    today.getMonth() === cell.month &&
                                    today.getDate() === cell.day;

                                return (
                                    <Button
                                        key={idx}
                                        className='skerry-calendar-day-btn'
                                        size='small'
                                        onClick={() => handleSelectDay(cell.year, cell.month, cell.day)}
                                        sx={{
                                            minWidth: '0 !important',
                                            maxWidth: '32px !important',
                                            width: '32px !important',
                                            height: '32px !important',
                                            minHeight: '32px !important',
                                            p: '0 !important',
                                            borderRadius: '6px !important',
                                            fontSize: '0.82rem',
                                            fontWeight: isSelected ? 700 : 500,
                                            color: isSelected
                                                ? 'primary.contrastText'
                                                : cell.isCurrentMonth
                                                    ? 'text.primary'
                                                    : 'text.disabled',
                                            backgroundColor: isSelected
                                                ? 'primary.main'
                                                : isToday
                                                    ? 'action.hover'
                                                    : 'transparent',
                                            border: isToday && !isSelected ? '1px solid' : 'none',
                                            borderColor: 'primary.light',
                                            '&:hover': {
                                                backgroundColor: isSelected ? 'primary.dark' : 'action.selected',
                                            },
                                        }}
                                    >
                                        {cell.day}
                                    </Button>
                                );
                            })}
                        </Box>
                    </>
                ) : (
                    <Box
                        sx={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(3, 1fr)',
                            gap: 1,
                            py: 1,
                        }}
                    >
                        {yearsList.map((y) => {
                            const isSelected = navYear === y;
                            return (
								<Button
									key={y}
									size='small'
									variant={isSelected ? 'contained' : 'text'}
									onClick={() => {
										setNavYear(y);
										setView('days');
									}}
									sx={{
										borderRadius: 1,
										fontWeight: isSelected ? 700 : 500,
										fontSize: '0.88rem',
									}}
								>
									{y}
								</Button>
                            );
                        })}
                    </Box>
                )}

                <Stack
                    direction='row'
                    justifyContent='space-between'
                    alignItems='center'
                    sx={{ mt: 2, pt: 1, borderTop: '1px solid', borderColor: 'divider' }}
                >
                    <Button size='small' color='inherit' onClick={handleClear} sx={{ fontSize: '0.8rem' }}>
                        清除
                    </Button>
                    <Button size='small' color='primary' onClick={handleToday} sx={{ fontSize: '0.8rem', fontWeight: 600 }}>
                        今天
                    </Button>
                </Stack>
            </Popover>
        </>
    );
}

interface SkerryDateTimePickerProps {
    label?: string;
    value?: string;
    onChange: (value: string) => void;
    fullWidth?: boolean;
    disabled?: boolean;
    error?: boolean;
    helperText?: React.ReactNode;
}

const parseDateTimeString = (val?: string): {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
} | null => {
    if (!val) return null;
    const parts = val.trim().split('T');
    if (parts.length < 2) return null;
    const datePart = parseDateString(parts[0]);
    if (!datePart) return null;
    const timeParts = parts[1].split(':');
    if (timeParts.length < 2) return null;
    const hour = parseInt(timeParts[0], 10);
    const minute = parseInt(timeParts[1], 10);
    if (isNaN(hour) || isNaN(minute)) return null;
    return { ...datePart, hour, minute };
};

const formatDateTimeString = (
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
) => formatDateString(year, month, day) + 'T' + pad2(hour) + ':' + pad2(minute);

export function SkerryDateTimePicker({
    label,
    value = '',
    onChange,
    fullWidth = false,
    disabled = false,
    error = false,
    helperText,
}: SkerryDateTimePickerProps) {
    const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
    const [view, setView] = useState<'days' | 'years'>('days');

    const parsed = useMemo(() => parseDateTimeString(value), [value]);
    const today = useMemo(() => new Date(), []);

    const [navYear, setNavYear] = useState<number>(parsed?.year ?? today.getFullYear());
    const [navMonth, setNavMonth] = useState<number>(parsed?.month ?? today.getMonth());
    const [selectedDay, setSelectedDay] = useState<number>(parsed?.day ?? today.getDate());
    const [selectedHour, setSelectedHour] = useState<number>(parsed?.hour ?? today.getHours());
    const [selectedMinute, setSelectedMinute] = useState<number>(parsed?.minute ?? today.getMinutes());
    const [yearPage, setYearPage] = useState<number>(Math.floor((parsed?.year ?? today.getFullYear()) / 12) * 12);

    const handleOpen = (event: React.MouseEvent<HTMLElement>) => {
        if (disabled) return;
        const current = parseDateTimeString(value) || {
            year: today.getFullYear(),
            month: today.getMonth(),
            day: today.getDate(),
            hour: today.getHours(),
            minute: today.getMinutes(),
        };
        setNavYear(current.year);
        setNavMonth(current.month);
        setSelectedDay(current.day);
        setSelectedHour(current.hour);
        setSelectedMinute(current.minute);
        setYearPage(Math.floor(current.year / 12) * 12);
        setView('days');
        setAnchorEl(event.currentTarget);
    };

    const handleClose = () => {
        setAnchorEl(null);
        setView('days');
    };

    const isOpen = Boolean(anchorEl);

    const handlePrevMonth = () => {
        if (navMonth === 0) {
            setNavMonth(11);
            setNavYear((y) => y - 1);
        } else {
            setNavMonth((m) => m - 1);
        }
    };

    const handleNextMonth = () => {
        if (navMonth === 11) {
            setNavMonth(0);
            setNavYear((y) => y + 1);
        } else {
            setNavMonth((m) => m + 1);
        }
    };

    const calendarDays = useMemo(() => {
        const firstDayIndex = new Date(navYear, navMonth, 1).getDay();
        const daysInMonth = new Date(navYear, navMonth + 1, 0).getDate();
        const daysInPrevMonth = new Date(navYear, navMonth, 0).getDate();

        const cells: Array<{
            year: number;
            month: number;
            day: number;
            isCurrentMonth: boolean;
        }> = [];

        for (let i = firstDayIndex - 1; i >= 0; i--) {
            const prevMonth = navMonth === 0 ? 11 : navMonth - 1;
            const prevYear = navMonth === 0 ? navYear - 1 : navYear;
            cells.push({
                year: prevYear,
                month: prevMonth,
                day: daysInPrevMonth - i,
                isCurrentMonth: false,
            });
        }

        for (let day = 1; day <= daysInMonth; day++) {
            cells.push({
                year: navYear,
                month: navMonth,
                day,
                isCurrentMonth: true,
            });
        }
        const totalNeeded = cells.length > 35 ? 42 : 35;
        const extra = totalNeeded - cells.length;
        for (let day = 1; day <= extra; day++) {
            const nextMonth = navMonth === 11 ? 0 : navMonth + 1;
            const nextYear = navMonth === 11 ? navYear + 1 : navYear;
            cells.push({
                year: nextYear,
                month: nextMonth,
                day,
                isCurrentMonth: false,
            });
        }

        return cells;
    }, [navYear, navMonth]);

    const commitDateTime = (y: number, m: number, d: number, h: number, min: number) => {
        onChange(formatDateTimeString(y, m, d, h, min));
    };

    const handleSelectDay = (year: number, month: number, day: number) => {
        setNavYear(year);
        setNavMonth(month);
        setSelectedDay(day);
        commitDateTime(year, month, day, selectedHour, selectedMinute);
    };

    const handleHourChange = (h: number) => {
        setSelectedHour(h);
        commitDateTime(navYear, navMonth, selectedDay, h, selectedMinute);
    };

    const handleMinuteChange = (min: number) => {
        setSelectedMinute(min);
        commitDateTime(navYear, navMonth, selectedDay, selectedHour, min);
    };

    const handleNow = () => {
        const now = new Date();
        setNavYear(now.getFullYear());
        setNavMonth(now.getMonth());
        setSelectedDay(now.getDate());
        setSelectedHour(now.getHours());
        setSelectedMinute(now.getMinutes());
        commitDateTime(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes());
        handleClose();
    };

    const handleClear = () => {
        onChange('');
        handleClose();
    };

    const yearsList = useMemo(() => {
        const list = [];
        for (let y = yearPage; y < yearPage + 12; y++) {
            list.push(y);
        }
        return list;
    }, [yearPage]);

    return (
        <>
            <TextField
                label={label}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder='YYYY-MM-DDTHH:mm'
                fullWidth={fullWidth}
                disabled={disabled}
                error={error}
                helperText={helperText}
                InputProps={{
                    endAdornment: (
                        <InputAdornment position='end'>
                            <IconButton
                                size='small'
                                edge='end'
                                onClick={handleOpen}
                                disabled={disabled}
                                sx={{ color: 'text.secondary' }}
                            >
                                <AccessTimeIcon fontSize='small' />
                            </IconButton>
                        </InputAdornment>
                    ),
                }}
            />

            <Popover
                open={isOpen}
                anchorEl={anchorEl}
                onClose={handleClose}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                transformOrigin={{ vertical: 'top', horizontal: 'right' }}
                PaperProps={{
                    sx: {
                        p: 1.5,
                        width: 300,
                        background: 'var(--skerry-glass-surface, #1e293b)',
                        backdropFilter: 'blur(24px) saturate(140%)',
                        border: '1px solid var(--skerry-glass-border, rgba(255, 255, 255, 0.12))',
                        borderRadius: 1,
                        boxShadow: '0 16px 40px rgba(0, 0, 0, 0.4)',
                        userSelect: 'none',
                    },
                }}
            >
                <Stack direction='row' alignItems='center' justifyContent='space-between' sx={{ mb: 1.5 }}>
                    <IconButton
                        size='small'
                        onClick={view === 'days' ? handlePrevMonth : () => setYearPage((p) => p - 12)}
                    >
                        <ChevronLeftIcon fontSize='small' />
                    </IconButton>

                    <Button
                        size='small'
                        variant='text'
                        onClick={() => setView((v) => (v === 'days' ? 'years' : 'days'))}
                        sx={{
                            fontWeight: 700,
                            fontSize: '0.95rem',
                            color: 'text.primary',
                            textTransform: 'none',
                        }}
                    >
                        {view === 'days' ? String(navYear) + '年 ' + String(navMonth + 1) + '月' : String(yearPage) + ' - ' + String(yearPage + 11)}
                    </Button>

                    <IconButton
                        size='small'
                        onClick={view === 'days' ? handleNextMonth : () => setYearPage((p) => p + 12)}
                    >
                        <ChevronRightIcon fontSize='small' />
                    </IconButton>
                </Stack>

                {view === 'days' ? (
                    <>
                        <Box
                            sx={{
                                display: 'grid',
                                gridTemplateColumns: 'repeat(7, 32px)',
                                justifyContent: 'center',
                                textAlign: 'center',
                                gap: '4px',
                                mb: 1,
                            }}
                        >
                            {WEEKDAYS.map((wd) => (
                                <Typography key={wd} variant='caption' color='text.secondary' fontWeight={600} sx={{ width: 32, textAlign: 'center' }}>
                                    {wd}
                                </Typography>
                            ))}
                        </Box>

                        <Box
                            sx={{
                                display: 'grid',
                                gridTemplateColumns: 'repeat(7, 32px)',
                                justifyContent: 'center',
                                gap: '4px',
                            }}
                        >
                            {calendarDays.map((cell, idx) => {
                                const isSelected =
                                    navYear === cell.year &&
                                    navMonth === cell.month &&
                                    selectedDay === cell.day;
                                const isToday =
                                    today.getFullYear() === cell.year &&
                                    today.getMonth() === cell.month &&
                                    today.getDate() === cell.day;

                                return (
                                    <Button
                                        key={idx}
                                        className='skerry-calendar-day-btn'
                                        size='small'
                                        onClick={() => handleSelectDay(cell.year, cell.month, cell.day)}
                                        sx={{
                                            minWidth: '0 !important',
                                            maxWidth: '32px !important',
                                            width: '32px !important',
                                            height: '32px !important',
                                            minHeight: '32px !important',
                                            p: '0 !important',
                                            borderRadius: '6px !important',
                                            fontSize: '0.82rem',
                                            fontWeight: isSelected ? 700 : 500,
                                            color: isSelected
                                                ? 'primary.contrastText'
                                                : cell.isCurrentMonth
                                                    ? 'text.primary'
                                                    : 'text.disabled',
                                            backgroundColor: isSelected
                                                ? 'primary.main'
                                                : isToday
                                                    ? 'action.hover'
                                                    : 'transparent',
                                            border: isToday && !isSelected ? '1px solid' : 'none',
                                            borderColor: 'primary.light',
                                            '&:hover': {
                                                backgroundColor: isSelected ? 'primary.dark' : 'action.selected',
                                            },
                                        }}
                                    >
                                        {cell.day}
                                    </Button>
                                );
                            })}
                        </Box>
                    </>
                ) : (
                    <Box
                        sx={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(3, 1fr)',
                            gap: 1,
                            py: 1,
                        }}
                    >
                        {yearsList.map((y) => {
                            const isSelected = navYear === y;
                            return (
								<Button
									key={y}
									size='small'
									variant={isSelected ? 'contained' : 'text'}
									onClick={() => {
										setNavYear(y);
										setView('days');
									}}
									sx={{
										borderRadius: 1,
										fontWeight: isSelected ? 700 : 500,
										fontSize: '0.88rem',
									}}
								>
									{y}
								</Button>
                            );
                        })}
                    </Box>
                )}

                <Box sx={{ mt: 2, pt: 1.5, borderTop: '1px solid', borderColor: 'divider' }}>
                    <Stack direction='row' alignItems='center' justifyContent='space-between'>
                        <Typography variant='caption' color='text.secondary' fontWeight={600}>
                            时间选择
                        </Typography>
                        <Stack direction='row' alignItems='center' spacing={1}>
                            <Select
                                size='small'
                                value={selectedHour}
                                onChange={(e) => handleHourChange(Number(e.target.value))}
                                sx={{
                                    height: 32,
                                    fontSize: '0.85rem',
                                    minWidth: 64,
                                    borderRadius: 1,
                                }}
                            >
                                {Array.from({ length: 24 }).map((_, h) => (
                                    <MenuItem key={h} value={h} sx={{ fontSize: '0.85rem' }}>
                                        {pad2(h)} 时
                                    </MenuItem>
                                ))}
                            </Select>
                            <Typography variant='body2' fontWeight={700}>
                                :
                            </Typography>
                            <Select
                                size='small'
                                value={selectedMinute}
                                onChange={(e) => handleMinuteChange(Number(e.target.value))}
                                sx={{
                                    height: 32,
                                    fontSize: '0.85rem',
                                    minWidth: 64,
                                    borderRadius: 1,
                                }}
                            >
                                {Array.from({ length: 60 }).map((_, m) => (
                                    <MenuItem key={m} value={m} sx={{ fontSize: '0.85rem' }}>
                                        {pad2(m)} 分
                                    </MenuItem>
                                ))}
                            </Select>
                        </Stack>
                    </Stack>
                </Box>

                <Stack
                    direction='row'
                    justifyContent='space-between'
                    alignItems='center'
                    sx={{ mt: 2, pt: 1, borderTop: '1px solid', borderColor: 'divider' }}
                >
                    <Button size='small' color='inherit' onClick={handleClear} sx={{ fontSize: '0.8rem' }}>
                        清除
                    </Button>
                    <Stack direction='row' spacing={1}>
                        <Button size='small' color='inherit' onClick={handleNow} sx={{ fontSize: '0.8rem' }}>
                            现在
                        </Button>
                        <Button
                            size='small'
                            variant='contained'
                            onClick={handleClose}
                            sx={{ fontSize: '0.8rem', fontWeight: 600, borderRadius: 1 }}
                        >
                            确定
                        </Button>
                    </Stack>
                </Stack>
            </Popover>
        </>
    );
}