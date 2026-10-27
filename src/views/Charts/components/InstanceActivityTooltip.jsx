const InstanceActivityTooltip = ({
    color,
    displayName,
    icon,
    joinTime,
    leaveTime,
    duration,
    statusLabel
}) => {
    return (
        <div style={{ display: 'flex', alignItems: 'center' }}>
            <div
                style={{
                    width: '10px',
                    height: '55px',
                    backgroundColor: color,
                    marginRight: '6px'
                }}
            />
            <div>
                <div>
                    {displayName} {icon}
                </div>
                <div>
                    {joinTime} - {leaveTime}
                </div>
                <div>{duration}</div>
                {statusLabel && <div>{statusLabel}</div>}
            </div>
        </div>
    );
};

export default InstanceActivityTooltip;
