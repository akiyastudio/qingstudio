const METADATA_GROUP_LABELS: Record<string, string> = {
  Application: '文件', System: '文件系统', File: '文件属性', IFD0: '图像与相机', ExifIFD: '拍摄信息', ExifIFD1: '拍摄信息',
  Composite: '计算信息', MakerNotes: '相机厂商信息', XMP: '可扩展元数据', XMPdc: '内容描述', XMPphotoshop: '图像编辑信息', XMPxmp: '基础元数据',
  IPTC: '新闻图片信息', ICC_Profile: '颜色配置', QuickTime: '媒体容器', Track1: '视频轨道', Track2: '音频轨道', Track3: '媒体轨道',
  RIFF: '媒体容器', PNG: '图像格式信息', JFIF: '图像交换信息', GPS: '位置信息', ExifTool: '元数据解析信息', Other: '其他元数据', 其他: '其他元数据',
};

const METADATA_FIELD_LABELS: Record<string, string> = {
  FileName: '文件名', Directory: '所在文件夹', FileSize: '文件大小', FileType: '文件类型', FileTypeExtension: '文件扩展名', MIMEType: '媒体类型', FilePermissions: '文件权限',
  FileCreateDate: '文件创建时间', FileModifyDate: '文件修改时间', FileAccessDate: '文件访问时间', FileInodeChangeDate: '文件索引修改时间',
  ImageWidth: '图像宽度', ImageHeight: '图像高度', ImageSize: '图像尺寸', ExifImageWidth: '照片宽度', ExifImageHeight: '照片高度', SourceImageWidth: '源图宽度', SourceImageHeight: '源图高度',
  Make: '相机厂商', Model: '相机型号', CameraModelName: '相机型号', SerialNumber: '相机序列号', Lens: '镜头', LensModel: '镜头型号', LensMake: '镜头厂商', LensSerialNumber: '镜头序列号',
  DateTimeOriginal: '原始拍摄时间', CreateDate: '创建时间', ModifyDate: '修改时间', OffsetTime: '时区偏移', OffsetTimeOriginal: '拍摄时区偏移', OffsetTimeDigitized: '数字化时区偏移',
  ExposureTime: '曝光时间', ShutterSpeed: '快门速度', ShutterSpeedValue: '快门速度值', FNumber: '光圈值', Aperture: '光圈', ApertureValue: '光圈值', ISO: '感光度', ISOSpeed: '感光速度',
  FocalLength: '焦距', FocalLengthIn35mmFormat: '等效焦距', FocalLength35efl: '等效焦距', ExposureProgram: '曝光程序', ExposureMode: '曝光模式', MeteringMode: '测光模式', ExposureCompensation: '曝光补偿',
  WhiteBalance: '白平衡', LightSource: '光源', Flash: '闪光灯', ColorSpace: '色彩空间', Orientation: '方向', ResolutionUnit: '分辨率单位', XResolution: '水平分辨率', YResolution: '垂直分辨率',
  BitsPerSample: '每通道位数', SamplesPerPixel: '每像素通道数', Compression: '压缩方式', PhotometricInterpretation: '颜色解释', Software: '处理软件', Artist: '作者', Copyright: '版权', ImageDescription: '图像说明', UserComment: '用户备注',
  Rating: '星级评分', RatingPercent: '评分百分比', Label: '颜色标签', Keywords: '关键词', Subject: '主题', Title: '标题', Description: '说明', Creator: '创作者', Rights: '版权信息',
  GPSLatitude: '纬度', GPSLongitude: '经度', GPSAltitude: '海拔', GPSPosition: '坐标位置', GPSDateTime: '定位时间', GPSImgDirection: '拍摄方向', GPSSpeed: '移动速度',
  Duration: '时长', MediaDuration: '媒体时长', TrackDuration: '轨道时长', VideoFrameRate: '视频帧率', CaptureFrameRate: '采集帧率', AvgBitrate: '平均码率', Bitrate: '码率',
  VideoCodec: '视频编码', AudioCodec: '音频编码', CompressorName: '编码器名称', Encoder: '编码器', AudioFormat: '音频格式', AudioChannels: '音频声道数', AudioSampleRate: '音频采样率', AudioBitsPerSample: '音频位深',
  MajorBrand: '主要容器格式', MinorVersion: '容器版本', CompatibleBrands: '兼容容器格式', MediaCreateDate: '媒体创建时间', MediaModifyDate: '媒体修改时间', TrackCreateDate: '轨道创建时间', TrackModifyDate: '轨道修改时间',
  ProfileDescription: '颜色配置说明', ColorPrimaries: '色彩原色', TransferCharacteristics: '传输特性', MatrixCoefficients: '颜色矩阵系数', ExifToolVersion: '解析器版本', Warning: '警告', Error: '错误',
};

export const metadataFieldLabel = (name: string) => {
  const source = String(name ?? '');
  if (!source.trim()) return '未命名属性';
  return METADATA_FIELD_LABELS[source] || source;
};

export const metadataGroupLabel = (group: string) => {
  const source = String(group ?? '');
  if (!source.trim()) return '未命名属性';
  return METADATA_GROUP_LABELS[source] || source;
};
